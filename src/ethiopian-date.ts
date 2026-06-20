export function toEthiopian(date: Date): { year: number; month: number; day: number } {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()

  const jdOffset = 1723856
  const a = Math.floor((14 - month) / 12)
  const y = year + 4800 - a
  const m = month + 12 * a - 3

  const jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045

  const jdEth = jd - jdOffset
  const r = (jdEth % 1461)
  const n = (r % 365) + 365 * Math.floor(r / 1460)

  const ethYear = 4 * Math.floor((jdEth) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460)
  const ethMonth = Math.floor(n / 30) + 1
  const ethDay = (n % 30) + 1

  return { year: ethYear, month: ethMonth, day: ethDay }
}

export function getNowEthiopian(): { year: number; month: number; day: number } {
  return toEthiopian(new Date())
}
