// Driver/dispatch persistence through the Supabase JS client (the original behaviour).
// Every method resolves to the Supabase-style { data, error } and never throws for database
// errors, so server.js can keep classifying missing tables / columns / functions itself.
const {
  DELIVERY_ATTEMPT_COLUMNS,
  DRIVER_SESSION_COLUMNS,
  INVOICE_COLUMNS,
  ROUTE_PLAN_COLUMNS,
} = require('./columns');

function createSupabaseStore(supabase) {
  return {
    kind: 'supabase',
    schemaLabel: 'Supabase table public',

    // --- driver_sessions / driver_locations ---
    loadDriverSessions(driverIds, { timeoutMs } = {}) {
      let query = supabase
        .from('driver_sessions')
        .select(DRIVER_SESSION_COLUMNS)
        .in('driver_id', driverIds);
      if (timeoutMs) query = query.abortSignal(AbortSignal.timeout(timeoutMs));
      return query;
    },

    upsertDriverSession(driverId, patch) {
      return supabase
        .from('driver_sessions')
        .upsert({ driver_id: driverId, ...patch }, { onConflict: 'driver_id' });
    },

    insertDriverLocation(row) {
      return supabase.from('driver_locations').insert(row);
    },

    // --- driver_route_plans ---
    listRoutePlans(planDate) {
      return supabase
        .from('driver_route_plans')
        .select(ROUTE_PLAN_COLUMNS)
        .eq('plan_date', planDate)
        .order('driver_id', { ascending: true });
    },

    updateRoutePlanOrders(driverId, planDate, orderIds, updatedAt) {
      return supabase
        .from('driver_route_plans')
        .update({ order_ids: orderIds, updated_at: updatedAt })
        .eq('driver_id', driverId)
        .eq('plan_date', planDate);
    },

    // Resolves to { data: [{ driver_id }] } with the deleted rows.
    deleteRoutePlan(driverId, planDate) {
      return supabase
        .from('driver_route_plans')
        .delete()
        .eq('driver_id', driverId)
        .eq('plan_date', planDate)
        .select('driver_id');
    },

    upsertRoutePlan(row) {
      return supabase
        .from('driver_route_plans')
        .upsert(row, { onConflict: 'driver_id,plan_date' })
        .select(ROUTE_PLAN_COLUMNS)
        .single();
    },

    // --- delivery_attempts ---
    insertDeliveryAttempt(row) {
      return supabase.from('delivery_attempts').insert(row);
    },

    async findDeliveryAttemptByKey(driverId, requestKey) {
      const { data, error } = await supabase
        .from('delivery_attempts')
        .select(DELIVERY_ATTEMPT_COLUMNS)
        .eq('driver_id', driverId)
        .eq('client_request_id', requestKey)
        .order('attempted_at', { ascending: true })
        .limit(1);
      return { data: data?.[0] || null, error };
    },

    listDeliveryAttempts({ start, end, driverId, outcome, withKey }) {
      let query = supabase
        .from('delivery_attempts')
        .select(withKey ? `${DELIVERY_ATTEMPT_COLUMNS}, client_request_id` : DELIVERY_ATTEMPT_COLUMNS)
        .gte('attempted_at', start)
        .lt('attempted_at', end)
        .order('attempted_at', { ascending: true })
        .limit(2000);
      if (driverId) query = query.eq('driver_id', driverId);
      if (outcome) query = query.eq('outcome', outcome);
      return query;
    },

    // --- invoices ---
    findInvoiceByOrder(orderId, driverId) {
      let query = supabase.from('invoices').select(INVOICE_COLUMNS).eq('order_id', orderId);
      if (driverId) query = query.eq('driver_id', driverId);
      return query.maybeSingle();
    },

    findInvoiceById(invoiceId) {
      return supabase.from('invoices').select(INVOICE_COLUMNS).eq('id', invoiceId).maybeSingle();
    },

    listInvoices({ start, end, driverId }) {
      let query = supabase
        .from('invoices')
        .select(INVOICE_COLUMNS)
        .gte('issued_at', start)
        .lt('issued_at', end)
        .order('issued_at', { ascending: true })
        .limit(2000);
      if (driverId) query = query.eq('driver_id', driverId);
      return query;
    },

    nextInvoiceNumber() {
      return supabase.rpc('next_invoice_number');
    },

    insertInvoice(row) {
      return supabase.from('invoices').insert(row).select(INVOICE_COLUMNS).single();
    },

    setInvoicePdf(invoiceId, bucket, objectPath) {
      return supabase
        .from('invoices')
        .update({ pdf_bucket: bucket, pdf_path: objectPath })
        .eq('id', invoiceId)
        .select(INVOICE_COLUMNS)
        .single();
    },

    async close() {},
  };
}

module.exports = { createSupabaseStore };
