export interface Order {
  id: string
  courseId: string
  currency: string
  createdAt: string
  priceMinor: number
  courseTitle: string
  status: 'simulated_paid'
}
