import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { toEthiopian, getNowEthiopian } from './ethiopian-date'

const RECEIPT_VERIFIER_URL = process.env.RECEIPT_VERIFIER_URL || 'https://receipt-verifier-production.up.railway.app'

export interface ExtractedReceipt {
  payer_name: string | null
  payer_account: string | null
  receiver_name: string | null
  receiver_account: string | null
  amount: number | null
  currency: string
  reference: string | null
  date: string | null
  status: string | null
}

export interface MatchedMonth {
  month: number
  year: number
  enrollment_id: string
  amount: number
}

export interface ApplyPaymentSuccess {
  success: true
  message: string
  receipt: ExtractedReceipt
  matched_months: MatchedMonth[]
  payer_matched: boolean
}

export interface ApplyPaymentError {
  success: false
  error: string
}

export type ApplyPaymentResult = ApplyPaymentSuccess | ApplyPaymentError

function namesMatch(payerName: string | null, memberFullName: string | null): boolean {
  if (!payerName || !memberFullName) return false
  const payerWords = new Set(
    payerName.toLowerCase().match(/\w+/g)?.filter(w => w.length > 1) || []
  )
  const memberWords = new Set(
    memberFullName.toLowerCase().match(/\w+/g)?.filter(w => w.length > 1) || []
  )
  if (payerWords.size === 0 || memberWords.size === 0) return false
  let overlap = 0
  for (const w of payerWords) {
    if (memberWords.has(w)) overlap++
  }
  return overlap >= 1
}

async function extractReceipt(bank: string, url: string): Promise<ExtractedReceipt> {
  const response = await fetch(`${RECEIPT_VERIFIER_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bank, url }),
  })

  if (!response.ok) {
    const body: any = await response.json().catch(() => ({}))
    throw new Error(body.detail || `Extraction failed (${response.status})`)
  }

  const result: any = await response.json()
  return result.data as ExtractedReceipt
}

interface ApplyPaymentInput {
  member_id: string
  bank: string
  receipt_url: string
}

export async function applyPayment(
  supabase: SupabaseClient,
  input: ApplyPaymentInput
): Promise<ApplyPaymentResult> {
  // 1. Extract receipt data
  let receipt: ExtractedReceipt
  try {
    receipt = await extractReceipt(input.bank, input.receipt_url)
  } catch (e: any) {
    return { success: false, error: e.message || 'Failed to extract receipt' }
  }

  if (!receipt.amount || receipt.amount <= 0) {
    return { success: false, error: 'Could not determine payment amount from receipt' }
  }

  // 2. Fetch member
  const { data: member, error: memberError } = await supabase
    .from('members')
    .select('*')
    .eq('id', input.member_id)
    .maybeSingle()

  if (memberError) return { success: false, error: `Database error: ${memberError.message}` }
  if (!member) return { success: false, error: 'Member not found' }

  // 3. Cross-check payer name
  const payerMatched = namesMatch(receipt.payer_name, member.full_name)
  if (!payerMatched) {
    return {
      success: false,
      error: `Receipt payer name '${receipt.payer_name}' does not match your name '${member.full_name}'. This receipt belongs to someone else.`,
    }
  }

  // 4. Check for duplicate reference
  const ref = receipt.reference
  if (ref) {
    const { data: dup } = await supabase
      .from('payment_declarations')
      .select('id')
      .eq('reference_number', ref)
      .maybeSingle()

    if (dup) {
      return { success: false, error: `This receipt (ref: ${ref}) has already been used to make a payment.` }
    }
  }

  // 5. Fetch enrollments
  const { data: enrollments, error: envError } = await supabase
    .from('member_enrollments')
    .select('*')
    .eq('member_id', input.member_id)

  if (envError) return { success: false, error: `Database error: ${envError.message}` }

  // 6. Fetch existing payments
  const { data: existingPayments } = await supabase
    .from('member_payments')
    .select('*')
    .eq('member_id', input.member_id)

  const paidKeys = new Set<string>()
  for (const p of (existingPayments || [])) {
    if (p.type !== 'charity' && p.payment_for_month) {
      paidKeys.add(`${p.payment_for_year}-${p.payment_for_month}`)
    }
  }

  // 7. Calculate matched months
  const currentEth = getNowEthiopian()
  const currentTotal = currentEth.year * 13 + currentEth.month

  const matchedMonths: MatchedMonth[] = []
  let remaining = receipt.amount

  for (const env of (enrollments || []).sort((a, b) =>
    (a.enrollment_date || '').localeCompare(b.enrollment_date || '')
  )) {
    if (env.status !== 'active') continue

    // Fetch category fee
    const { data: catData } = await supabase
      .from('member_categories')
      .select('monthly_fee')
      .eq('name', env.category_name)
      .maybeSingle()

    let monthlyFee = catData?.monthly_fee || 0
    if (member.agreed_monthly_fee) monthlyFee = Number(member.agreed_monthly_fee)
    if (Number(member.extra_monthly_fee || 0) > 0) monthlyFee += Number(member.extra_monthly_fee)

    if (monthlyFee <= 0) continue

    // Convert enrollment date to Ethiopian
    const envDate = env.enrollment_date
    if (!envDate) continue
    const envDt = new Date(envDate)
    if (isNaN(envDt.getTime())) continue

    const ethEnv = toEthiopian(envDt)
    let checkY = ethEnv.year
    let checkM = ethEnv.month

    for (let i = 0; i < 500; i++) {
      if (checkY * 13 + checkM > currentTotal) break
      const key = `${checkY}-${checkM}`
      const isPagume = checkM === 13

      if (!paidKeys.has(key) && !isPagume && remaining >= monthlyFee) {
        matchedMonths.push({
          month: checkM,
          year: checkY,
          enrollment_id: env.id,
          amount: monthlyFee,
        })
        remaining -= monthlyFee
      }

      checkM++
      if (checkM > 13) {
        checkM = 1
        checkY++
      }
    }
  }

  if (matchedMonths.length === 0) {
    return {
      success: false,
      error: `The receipt amount (${receipt.amount} ETB) does not cover any unpaid months.`,
    }
  }

  // 8. Create payment records
  const nowIso = new Date().toISOString()
  const declarationRows = matchedMonths.map(mm => ({
    member_id: input.member_id,
    enrollment_id: mm.enrollment_id,
    amount: mm.amount,
    payment_method: 'receipt-verified',
    payment_for_month: mm.month,
    payment_for_year: mm.year,
    reference_number: ref || input.receipt_url,
    type: 'membership',
    status: 'approved',
    receipt_verified: true,
    receipt_data: receipt,
    receipt_url: input.receipt_url,
  }))

  const paymentRows = matchedMonths.map(mm => ({
    member_id: input.member_id,
    enrollment_id: mm.enrollment_id,
    amount: mm.amount,
    payment_for_month: mm.month,
    payment_for_year: mm.year,
    reference_number: ref || input.receipt_url,
    type: 'membership',
    payment_date: nowIso,
  }))

  const { error: declError } = await supabase
    .from('payment_declarations')
    .insert(declarationRows)

  if (declError) return { success: false, error: `Failed to create payment declaration: ${declError.message}` }

  const { error: payError } = await supabase
    .from('member_payments')
    .insert(paymentRows)

  if (payError) return { success: false, error: `Failed to create payment record: ${payError.message}` }

  return {
    success: true,
    message: `Payment applied: ${matchedMonths.length} month(s) covered.`,
    receipt,
    matched_months: matchedMonths,
    payer_matched: true,
  }
}
