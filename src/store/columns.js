// Column lists shared by the Supabase and PostgreSQL driver stores, so both return the same rows.
const ROUTE_PLAN_COLUMNS = 'driver_id, plan_date, order_ids, source, created_by, updated_at';
const DRIVER_SESSION_COLUMNS = 'driver_id, shift_status, shift_started_at, shift_ended_at, gps_sharing, last_latitude, last_longitude, last_accuracy, last_location_at, updated_at';
const INVOICE_COLUMNS = 'id, invoice_number, order_id, order_source, driver_id, customer_name, customer_phone, customer_address, items, subtotal_excl_vat, vat_amount, total_incl_vat, currency, payment_method, amount_paid, issued_at, pdf_bucket, pdf_path, created_at';
const DELIVERY_ATTEMPT_COLUMNS = 'id, order_id, order_source, driver_id, outcome, reason_code, note, payment_method, cash_collected, card_amount, card_reference, empty_bottles_returned, signature_bucket, signature_path, proof_bucket, proof_path, latitude, longitude, attempted_at';

// Columns callers may write; anything else in a row is ignored by the PostgreSQL store.
const DRIVER_SESSION_WRITE_COLUMNS = ['shift_status', 'shift_started_at', 'shift_ended_at', 'gps_sharing', 'last_latitude', 'last_longitude', 'last_accuracy', 'last_location_at', 'updated_at'];
const DELIVERY_ATTEMPT_WRITE_COLUMNS = ['order_id', 'order_source', 'driver_id', 'outcome', 'reason_code', 'note', 'payment_method', 'cash_collected', 'card_amount', 'card_reference', 'empty_bottles_returned', 'signature_bucket', 'signature_path', 'proof_bucket', 'proof_path', 'latitude', 'longitude', 'attempted_at', 'client_request_id'];
const INVOICE_WRITE_COLUMNS = ['invoice_number', 'order_id', 'order_source', 'driver_id', 'customer_name', 'customer_phone', 'customer_address', 'items', 'subtotal_excl_vat', 'vat_amount', 'total_incl_vat', 'currency', 'payment_method', 'amount_paid', 'issued_at', 'pdf_bucket', 'pdf_path'];

module.exports = {
  DELIVERY_ATTEMPT_COLUMNS,
  DELIVERY_ATTEMPT_WRITE_COLUMNS,
  DRIVER_SESSION_COLUMNS,
  DRIVER_SESSION_WRITE_COLUMNS,
  INVOICE_COLUMNS,
  INVOICE_WRITE_COLUMNS,
  ROUTE_PLAN_COLUMNS,
};
