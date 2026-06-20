import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { applyPayment } from './apply-payment'

const PORT = parseInt(process.env.PORT || '8080', 10)
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || ''

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/apply-payment', async (req, res) => {
  const { member_id, bank, receipt_url } = req.body

  if (!member_id || !bank || !receipt_url) {
    res.status(400).json({
      success: false,
      error: 'member_id, bank, and receipt_url are required',
    })
    return
  }

  const result = await applyPayment(supabase, { member_id, bank, receipt_url })

  if (!result.success) {
    res.status(422).json(result)
    return
  }

  res.json(result)
})

app.listen(PORT, () => {
  console.log(`Payment service running on port ${PORT}`)
})
