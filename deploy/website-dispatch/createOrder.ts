// ============================================================
// createOrder.ts — order persistence + notifications for staff
// dispatch orders (mirrors public checkout POST /api/orders, which
// stays untouched). Pricing stays in calculateOrder.
// ============================================================
import { PoolClient } from 'pg'
import { generateOrderNumber, OrderLine } from '../utils/orderCalculator'
import { notifyNewOrder, confirmOrderToCustomer } from './wati'
import { sendAdminOrderEmail } from './email'
import { sendOrderConfirmationEmail } from './orderConfirmationEmail'

export interface InsertOrderInput {
  fullName: string
  accountPhone: string
  orderPhone: string
  email?: string
  initialStatus: string
  subtotal: number
  coupon_vat: number
  delivery_fee: number
  bottle_deposit: number
  discountAmount: number
  total: number
  paymentMethod: string
  paymentStatus: string
  deliveryDate?: string
  deliveryTimeSlot?: string
  addressSnapshot: Record<string, unknown>
  promoCodeId: string | null
  appliedPromoCode: string | null
  incrementPromoUsage: boolean
  notes?: string
  source: string
  referral?: Record<string, unknown>
  lines: OrderLine[]
}

export interface InsertedOrder {
  customerId: string
  order: { id: string, order_number: string, created_at: Date }
}

/**
 * Customer upsert + order/order_items inserts. Runs on a client that the
 * caller has already put inside a transaction (caller owns BEGIN/COMMIT).
 */
export async function insertOrderRecords(client: PoolClient, input: InsertOrderInput): Promise<InsertedOrder> {
  // Upsert customer
  const customerResult = await client.query(
    `INSERT INTO customers (full_name, phone, email, customer_type)
     VALUES ($1, $2, $3, 'b2c')
     ON CONFLICT (phone) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           email = COALESCE(NULLIF(EXCLUDED.email,''), customers.email),
           updated_at = NOW()
     RETURNING id`,
    [input.fullName, input.accountPhone, input.email || null]
  )
  const customerId = customerResult.rows[0].id

  // Customer snapshot
  const customerSnapshot = {
    full_name: input.fullName,
    phone:     input.orderPhone,
    email:     input.email || '',
  }

  // Generate order number
  const orderNumber = generateOrderNumber()

  // Insert order
  const orderResult = await client.query(
    `INSERT INTO orders (
       order_number, customer_id, status,
       subtotal, coupon_vat, delivery_fee, bottle_deposit, discount_amount, total,
       payment_method, payment_status,
       delivery_date, delivery_time_slot,
       address_snapshot, customer_snapshot,
       promo_code_id, promo_code,
       notes, source, referral
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id, order_number, created_at`,
    [
      orderNumber, customerId, input.initialStatus,
      input.subtotal, input.coupon_vat, input.delivery_fee, input.bottle_deposit, input.discountAmount, input.total,
      input.paymentMethod, input.paymentStatus,
      input.deliveryDate || null,
      input.deliveryTimeSlot || null,
      JSON.stringify(input.addressSnapshot),
      JSON.stringify(customerSnapshot),
      input.promoCodeId,
      input.appliedPromoCode,
      input.notes || null,
      input.source,
      JSON.stringify(input.referral || {}),
    ]
  )

  // Increment promo code usage
  if (input.promoCodeId && input.incrementPromoUsage) {
    await client.query(
      'UPDATE promo_codes SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [input.promoCodeId]
    )
  }

  const order = orderResult.rows[0]

  // Insert order items
  for (const line of input.lines) {
    await client.query(
      `INSERT INTO order_items (
         order_id, product_id, product_name, product_size,
         quantity, unit_price, line_subtotal,
         deposit_per_unit, deposit_total, total_price
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        order.id, line.product_id, line.product_name, line.product_size,
        line.quantity, line.unit_price, line.line_subtotal,
        line.deposit_per_unit, line.deposit_total, line.total_price,
      ]
    )
  }

  return { customerId, order }
}

export interface NewOrderNotification {
  orderId: string
  order_number: string
  customer_name: string
  customer_phone: string
  customer_email?: string
  total: number
  subtotal: number
  coupon_vat: number
  delivery_fee: number
  bottle_deposit: number
  emirate: string
  delivery_date?: string
  delivery_time_slot?: string
  payment_method: string
  address_snapshot: Record<string, unknown>
  lines: OrderLine[]
}

/** Post-commit notifications. Fire-and-forget: never blocks or fails the response. */
export function sendNewOrderNotifications(n: NewOrderNotification): void {
  const notifPayload = {
    order_number:       n.order_number,
    customer_name:      n.customer_name,
    customer_phone:     n.customer_phone,
    customer_email:     n.customer_email,
    total:              n.total,
    subtotal:           n.subtotal,
    coupon_vat:         n.coupon_vat,
    delivery_fee:       n.delivery_fee,
    bottle_deposit:     n.bottle_deposit,
    emirate:            n.emirate,
    delivery_date:      n.delivery_date,
    delivery_time_slot: n.delivery_time_slot,
    payment_method:     n.payment_method,
    address_snapshot:   n.address_snapshot,
    lines:              n.lines,
  }

  Promise.allSettled([
    notifyNewOrder(notifPayload, n.orderId),
    n.customer_email ? confirmOrderToCustomer({
      order_number: n.order_number,
      customer_name: n.customer_name,
      customer_phone: n.customer_phone,
      total: n.total,
      coupon_vat: n.coupon_vat,
      delivery_date: n.delivery_date,
      delivery_time_slot: n.delivery_time_slot,
    }, n.orderId) : Promise.resolve(),
    sendAdminOrderEmail(notifPayload),
    sendOrderConfirmationEmail(n.orderId),
  ]).catch(err => console.error('[Notifications] Error:', err))
}
