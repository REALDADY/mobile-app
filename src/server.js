const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

const SUPABASE_URL = 'https://ubzhbwyuoqhysnzuyvbk.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InViemhid3l1b3FoeXNuenV5dmJrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTYzMjcxNSwiZXhwIjoyMDkxMjA4NzE1fQ.22M0Y6s4Uu1oLpVlWDeL1riCKSnUNuNPTMTGaislxQ0';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const LOCAL_PRODUCT_CATALOG = {
  '5gal': { name: '5-Gallon Bottle', price: 14, is5Gallon: true },
  '1.5L': { name: '1.5L Bottle', price: 9, is5Gallon: false },
  '500ml': { name: '500ml Bottle', price: 12, is5Gallon: false },
  '250ml': { name: '250ml Bottle', price: 15, is5Gallon: false },
  '200ml': { name: '200ml Bottle', price: 11, is5Gallon: false },
  '150ml': { name: '150ml Bottle', price: 10, is5Gallon: false },
};

async function findAuthUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users || [];
    const match = users.find((user) => user.email?.toLowerCase() === normalizedEmail);
    if (match) return match;

    if (users.length < perPage) return null;
    page += 1;
  }
}

async function listAllAuthUsers() {
  const users = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const batch = data?.users || [];
    users.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }

  return users;
}

function buildAddressDisplay(record = {}) {
  return [
    record.building,
    record.apartment,
    record.address,
    record.city,
  ].filter(Boolean).join(', ');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createOrderInSupabase({ userId, amount, paymentMethod, orderPayload, initialStatus = 'PENDING' }) {
  const { data: order, error } = await supabase.from('orders').insert({
    user_id: userId,
    total_amount: amount,
    payment_method: paymentMethod,
    delivery_address: orderPayload.address,
    status: initialStatus,
    delivery_slot: orderPayload.deliverySlot || null,
  }).select().single();

  if (error) throw error;

  if (orderPayload.items?.length) {
    const { error: itemsError } = await supabase.from('order_items').insert(
      orderPayload.items.map((item) => ({
        order_id: order.id,
        // product IDs like "1.5L" are not UUIDs — send null to avoid postgres type error
        product_id: UUID_RE.test(item.productId || '') ? item.productId : null,
        quantity: item.quantity,
        subtotal: item.subtotal,
        used_credits: item.usedCredits || 0,
      }))
    );

    if (itemsError) {
      console.warn('Could not sync order items for order', order.id, itemsError.message);
    }
  }

  return order;
}

app.use(cors());
app.use(express.json());

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'RS Water API', version: '2.0.0' });
});

// --- Products ---
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { price: 'asc' } });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// --- Auth / User ---
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, phone } = req.body;
  const normalizedEmail = email?.trim().toLowerCase();
  const normalizedName = name?.trim();
  const normalizedPhone = phone?.trim();

  if (!normalizedEmail || !password || !normalizedName || !normalizedPhone) {
    return res.status(400).json({ error: 'Name, email, phone and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    let user = await findAuthUserByEmail(normalizedEmail);

    if (user) {
      const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
        password,
        email_confirm: true,
        user_metadata: { ...user.user_metadata, name: normalizedName, phone: normalizedPhone },
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      user = data.user;
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { name: normalizedName, phone: normalizedPhone },
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      user = data?.user || null;
    }

    if (!user) {
      return res.status(500).json({ error: 'User was not created' });
    }

    const { error: profileError } = await supabase.from('users').upsert({
      id: user.id,
      email: normalizedEmail,
      role: 'CUSTOMER',
      name: normalizedName,
    }, { onConflict: 'id' });

    if (profileError) {
      console.warn('Could not create public.users profile during registration:', profileError.message);
    }

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
      },
      message: 'Account created successfully',
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  try {
    let user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      user = await prisma.user.create({
        data: { phone, role: 'CUSTOMER', name: 'New User' }
      });
    }
    res.json({ user, token: `mock-jwt-${user.id}` });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { userId, amount, orderPayload, paymentMethod } = req.body;

  if (!userId || !amount || !orderPayload?.address || !orderPayload?.items?.length) {
    return res.status(400).json({ error: 'Missing order details' });
  }

  try {
    const order = await createOrderInSupabase({
      userId,
      amount,
      paymentMethod: paymentMethod || 'cod',
      orderPayload,
      initialStatus: 'PENDING',
    });

    res.status(201).json({ order });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET single user (for session refresh / balance sync)
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    // Only allow updating safe fields
    const { name, nameAr, address, building, apartment, city, locationLat, locationLng } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (nameAr !== undefined) updateData.nameAr = nameAr;
    if (address !== undefined) updateData.address = address;
    if (building !== undefined) updateData.building = building;
    if (apartment !== undefined) updateData.apartment = apartment;
    if (city !== undefined) updateData.city = city;
    if (locationLat !== undefined) updateData.locationLat = locationLat;
    if (locationLng !== undefined) updateData.locationLng = locationLng;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// --- Wallet & Credits ---
app.post('/api/users/:id/wallet/topup', async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { walletBalance: { increment: Number(amount) } }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Top up failed' });
  }
});

// Buy 5-gallon credit pack (280 AED = 20 credits)
app.post('/api/users/:id/wallet/buy-credits', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.walletBalance < 280) return res.status(400).json({ error: 'Insufficient wallet balance. Need 280 AED.' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        walletBalance: { decrement: 280 },
        bottleCredits: { increment: 20 }
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to buy credits' });
  }
});

// --- Network International (N-Genius) Payment Gateway ---
app.post('/api/payment/ngenius/topup', async (req, res) => {
  const { amount, userId } = req.body;

  if (!amount || !userId) {
    return res.status(400).json({ error: 'Missing amount or userId' });
  }

  try {
    const redirectUrl = `customerapp://payment-complete?amount=${amount}&userId=${userId}`;
    const orderData = await createNGeniusOrder(amount, redirectUrl);
    res.json(orderData);
  } catch (error) {
    console.error('N-Genius topup error:', error.message);
    res.status(500).json({ error: 'Payment gateway failed', details: error.message });
  }
});

// --- Orders (Backend Admin/Customer fallback) ---
app.post('/api/payment/ngenius/checkout', async (req, res) => {
  // A dedicated endpoint so the cart can actually charge the card + create order securely
  const { amount, userId, orderPayload } = req.body;
  if (!amount || !userId) return res.status(400).json({ error: 'Missing data' });

  try {
    const order = await createOrderInSupabase({
      userId,
      amount,
      paymentMethod: 'card',
      orderPayload,
      initialStatus: 'PENDING',
    });

    const encodedOrderId = encodeURIComponent(order.id);
    const orderData = await createNGeniusOrder(amount, `customerapp://checkout-complete?orderId=${encodedOrderId}`);
    res.json(orderData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

async function createNGeniusOrder(amount, redirectUrl) {
  const NI_API_KEY = process.env.NI_API_KEY || 'Yjc3MzM5Y2ItMWEwOC00MWNlLTliYTctNTg0ZGMwOWRiMGIzOjA4ZjgzZDdmLWMyODktNDMyZi04MTZlLTNlYTQ0YjZmYzMzYQ==';
  const NI_OUTLET_ID = process.env.NI_OUTLET_ID || '6f291f9f-6e76-440f-8feb-01fd43706da1';

  const tokenResp = await fetch("https://api-gateway.ngenius-payments.com/identity/auth/access-token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${NI_API_KEY}`,
      "Content-Type": "application/vnd.ni-identity.v1+json",
      "Accept": "application/vnd.ni-identity.v1+json"
    }
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    console.error(`N-Genius auth failed [${tokenResp.status}]:`, body);
    throw new Error(`N-Genius authentication failed (${tokenResp.status})`);
  }

  const tokenData = await tokenResp.json();

  const orderResp = await fetch(`https://api-gateway.ngenius-payments.com/transactions/outlets/${NI_OUTLET_ID}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/vnd.ni-payment.v2+json",
      "Accept": "application/vnd.ni-payment.v2+json"
    },
    body: JSON.stringify({
      action: "SALE",
      amount: { currencyCode: "AED", value: Math.round(amount * 100) },
      merchantAttributes: { redirectUrl, cancelUrl: `customerapp://payment-cancel`, skipConfirmationPage: true },
      paymentMethods: ["CARD"]
    })
  });

  if (!orderResp.ok) {
    const body = await orderResp.text();
    console.error(`N-Genius order creation failed [${orderResp.status}]:`, body);
    throw new Error(`N-Genius order creation failed (${orderResp.status}): ${body}`);
  }

  const orderData = await orderResp.json();

  if (!orderData._links?.payment?.href) {
    console.error('N-Genius response missing payment URL:', JSON.stringify(orderData));
    throw new Error('N-Genius did not return a payment URL');
  }

  return { paymentUrl: orderData._links.payment.href, orderRef: orderData.reference };
}

// --- Admin Endpoints ---
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const [ordersCount, totalRevenueAgg, customersCount, damagedCount] = await Promise.all([
      prisma.order.count(),
      prisma.order.aggregate({ _sum: { totalAmount: true } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.delivery.aggregate({ _sum: { bottlesDamaged: true } })
    ]);
    res.json({
      revenue: totalRevenueAgg._sum.totalAmount || 0,
      deliveries: ordersCount,
      customers: customersCount,
      damaged: damagedCount._sum.bottlesDamaged || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  try {
    const [authUsersResult, ordersResult] = await Promise.all([
      listAllAuthUsers(),
      supabase.from('orders')
        .select('*, user:users(*), items:order_items(*)')
        .order('created_at', { ascending: false }),
    ]);

    if (ordersResult.error) throw ordersResult.error;

    const phoneByEmail = new Map(
      authUsersResult
        .filter((user) => user.email)
        .map((user) => [user.email.toLowerCase(), user.user_metadata?.phone || user.phone || ''])
    );

    const orders = (ordersResult.data || []).map((order) => ({
      id: order.id,
      createdAt: order.created_at,
      totalAmount: order.total_amount,
      status: (order.status || 'PENDING').toUpperCase(),
      paymentMethod: order.payment_method || 'COD',
      paymentStatus: order.payment_status || 'UNPAID',
      deliveryAddress: order.delivery_address,
      deliverySlot: order.delivery_slot,
      user: order.user ? {
        id: order.user.id,
        name: order.user.name,
        email: order.user.email,
        phone: order.user.email ? (phoneByEmail.get(order.user.email.toLowerCase()) || '') : '',
        address: buildAddressDisplay(order.user),
        locationLat: order.user.location_lat,
        locationLng: order.user.location_lng,
      } : null,
      items: order.items || [],
    }));

    res.json(orders);
  } catch (error) {
    console.error('Failed to fetch admin orders:', error);
    res.status(500).json({ error: 'Failed to fetch admin orders' });
  }
});

app.put('/api/admin/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  // Normalize status to uppercase for backend consistency
  const normalizedStatus = status ? status.toUpperCase() : 'PENDING';
  // Map frontend status names to backend schema values
  const STATUS_MAP = {
    'ACTIVE': 'OUT_FOR_DELIVERY',
    'PROCESSING': 'PENDING',
    'DELIVERED': 'DELIVERED',
    'CANCELLED': 'CANCELLED',
    'PENDING': 'PENDING',
    'OUT_FOR_DELIVERY': 'OUT_FOR_DELIVERY',
  };
  const dbStatus = STATUS_MAP[normalizedStatus] || normalizedStatus;

  try {
    const { data: order, error } = await supabase.from('orders')
      .update({ status: dbStatus })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json(order);
  } catch (error) {
    console.error('Failed to update order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Admin: Get all customers
app.get('/api/admin/customers', async (req, res) => {
  try {
    const [authUsers, usersResult, ordersResult] = await Promise.all([
      listAllAuthUsers(),
      supabase.from('users').select('*').eq('role', 'CUSTOMER').order('created_at', { ascending: false }),
      supabase.from('orders').select('id, user_id, status, created_at, total_amount'),
    ]);

    if (usersResult.error) throw usersResult.error;
    if (ordersResult.error) throw ordersResult.error;

    const phoneByEmail = new Map(
      authUsers
        .filter((user) => user.email)
        .map((user) => [user.email.toLowerCase(), user.user_metadata?.phone || user.phone || ''])
    );

    const ordersByUserId = new Map();
    for (const order of ordersResult.data || []) {
      const bucket = ordersByUserId.get(order.user_id) || [];
      bucket.push(order);
      ordersByUserId.set(order.user_id, bucket);
    }

    const customers = (usersResult.data || []).map((customer) => {
      const customerOrders = ordersByUserId.get(customer.id) || [];
      const latestOrder = customerOrders
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

      return {
        id: customer.id,
        name: customer.name || 'Unknown',
        email: customer.email,
        phone: customer.email ? (phoneByEmail.get(customer.email.toLowerCase()) || '') : '',
        address: buildAddressDisplay(customer),
        locationLat: customer.location_lat,
        locationLng: customer.location_lng,
        credits: customer.bottle_credits || 0,
        walletBalance: customer.wallet_balance || 0,
        loyaltyPoints: customer.loyalty_points || 0,
        status: customerOrders.length > 0 ? 'ACTIVE' : 'INACTIVE',
        ordersCount: customerOrders.length,
        lastOrderAt: latestOrder?.created_at || null,
        avatar: (customer.name || 'U')
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() || '')
          .join('') || 'U',
      };
    });

    res.json(customers);
  } catch (error) {
    console.error('Failed to fetch customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`✅ RS Water Backend API is running on http://localhost:${PORT}`);
});
