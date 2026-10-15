// Darzi API — one backend for the website and the future iOS/Android apps.
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, migrate } = require('./db');
const PRICING = require('./pricing.json');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET is required'); process.exit(1); }
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://darzi-test.onrender.com,http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean);
const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d.length >= 11 && d.length <= 15 ? d : null; };
const STAFF = (process.env.STAFF_PHONES || '').split(',').map(normPhone).filter(Boolean);
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const SMS_LIVE = !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID);
const RZP_ID = process.env.RAZORPAY_KEY_ID, RZP_SECRET = process.env.RAZORPAY_KEY_SECRET;
const PAY_LIVE = !!(RZP_ID && RZP_SECRET);
const STATUSES = ['Design Approved', 'Measurement Confirmed', 'Fabric Selected', 'Production Started', 'Quality Check', 'Shipped', 'Delivered'];

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGINS.includes(o)) }));
app.use(express.json({ limit: '1mb' }));

const q = (text, params) => pool.query(text, params);
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------- pricing (same tables as the website, see tools/extract-pricing.js) ----------
function price(s) {
  const c = PRICING.cats[s.category]; if (!c) return null;
  let p = c.base + (PRICING.fabric[s.fabric] || 0);
  if (s.buttons === 'Double-breasted') p += 1500;
  if (s.buttons === 'Contrast buttons' || s.buttons === 'Wooden buttons') p += 200;
  if (['Extended', 'Mid-calf', 'Maxi', 'Floor', 'Asymmetric hem'].includes(s.length)) p += 300;
  if (s.pockets === 'Cargo pockets') p += 300;
  if (s.length === 'Bermuda') p -= 600;
  p += PRICING.patCost[s.pattern] ?? 250;
  return p;
}

// ---------- auth ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return bad(res, 401, 'Please sign in');
  try { req.user = jwt.verify(tok, JWT_SECRET); next(); } catch { bad(res, 401, 'Your session expired. Please sign in again'); }
}
const staffOnly = (req, res, next) => req.user.role === 'staff' ? next() : bad(res, 403, 'Staff only');

async function sendSms(phone, code) {
  if (!SMS_LIVE) return false;
  const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(process.env.MSG91_TEMPLATE_ID)}&mobile=${phone}&otp=${code}`;
  const r = await fetch(url, { method: 'POST', headers: { authkey: process.env.MSG91_AUTH_KEY, 'content-type': 'application/json' } });
  if (!r.ok) throw new Error('SMS provider error ' + r.status);
  return true;
}

app.get('/api/health', wrap(async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true, smsLive: SMS_LIVE, paymentsLive: PAY_LIVE, paymentKeyId: PAY_LIVE ? RZP_ID : null });
}));

app.post('/api/auth/otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return bad(res, 400, 'Enter a valid mobile number');
  const { rows } = await q("SELECT count(*)::int n FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '1 hour'", [phone]);
  if (rows[0].n >= 5) return bad(res, 429, 'Too many codes requested. Try again in an hour');
  const code = String(crypto.randomInt(100000, 1000000));
  await q("INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [phone, sha(phone + ':' + code)]);
  const sent = await sendSms(phone, code);
  // Test mode: no SMS provider configured, so the code is returned to show on screen.
  res.json({ sent, testMode: !sent, devCode: sent ? undefined : code });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone), code = String(req.body.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) return bad(res, 400, 'Enter the 6-digit code');
  const { rows } = await q('SELECT * FROM otp_codes WHERE phone=$1 AND used=false AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [phone]);
  const otp = rows[0];
  if (!otp) return bad(res, 400, 'That code has expired. Request a new one');
  if (otp.attempts >= 5) return bad(res, 429, 'Too many wrong attempts. Request a new code');
  if (otp.code_hash !== sha(phone + ':' + code)) {
    await q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [otp.id]);
    return bad(res, 400, 'That code is not right. Check and try again');
  }
  await q('UPDATE otp_codes SET used=true WHERE id=$1', [otp.id]);
  // Staff need their number listed in STAFF_PHONES; while SMS is in test mode they also need the admin PIN.
  const wantsStaff = STAFF.includes(phone) && (SMS_LIVE || (ADMIN_PIN && req.body.adminPin === ADMIN_PIN));
  const name = (req.body.name || '').toString().slice(0, 80) || null;
  const role = wantsStaff ? 'staff' : 'customer';
  const u = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3)
     ON CONFLICT (phone) DO UPDATE SET name=COALESCE(users.name, EXCLUDED.name), role=EXCLUDED.role
     RETURNING *`, [phone, name, role])).rows[0];
  const token = jwt.sign({ sub: u.id, role, phone }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: pubUser(u, role) });
}));

const pubUser = (u, role) => ({ id: u.id, phone: u.phone, name: u.name, email: u.email, address: u.address, role: role || u.role });

// ---------- customer data ----------
app.get('/api/me', auth, wrap(async (req, res) => {
  const id = req.user.sub;
  const [u, p, d, o, n] = await Promise.all([
    q('SELECT * FROM users WHERE id=$1', [id]),
    q('SELECT * FROM profiles WHERE user_id=$1 ORDER BY updated_at DESC', [id]),
    q('SELECT * FROM designs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [id]),
    q('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [id]),
    q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id]),
  ]);
  if (!u.rows[0]) return bad(res, 401, 'Please sign in again');
  res.json({ user: pubUser(u.rows[0], req.user.role), profiles: p.rows.map(profOut), designs: d.rows, orders: o.rows.map(orderOut), notifications: n.rows });
}));

app.patch('/api/me', auth, wrap(async (req, res) => {
  const { name, email, address } = req.body;
  const u = (await q('UPDATE users SET name=COALESCE($2,name), email=COALESCE($3,email), address=COALESCE($4,address) WHERE id=$1 RETURNING *',
    [req.user.sub, name ?? null, email ?? null, address ?? null])).rows[0];
  res.json({ user: pubUser(u, req.user.role) });
}));

const profOut = r => ({ id: r.id, name: r.name, rel: r.rel, fit: r.fit, sizes: r.sizes, photos: r.photos, updated: r.updated_at, m: r.data.m || null, ref: r.data.ref || null, adj: r.data.adj || {} });

app.put('/api/profiles/:id', auth, wrap(async (req, res) => {
  const b = req.body, id = String(req.params.id).slice(0, 64);
  const own = await q('SELECT user_id FROM profiles WHERE id=$1', [id]);
  if (own.rows[0] && own.rows[0].user_id !== req.user.sub) return bad(res, 403, 'Not your profile');
  const data = { m: b.m || null, ref: b.ref || null, adj: b.adj || {} };
  const r = (await q(`INSERT INTO profiles (id,user_id,name,rel,fit,sizes,data,photos,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
    ON CONFLICT (id) DO UPDATE SET name=$3, rel=$4, fit=$5, sizes=$6, data=$7, photos=$8, updated_at=now() RETURNING *`,
    [id, req.user.sub, String(b.name || 'Profile').slice(0, 80), b.rel || null, b.fit || null, b.sizes || null, data, !!b.photos])).rows[0];
  res.json({ profile: profOut(r) });
}));

app.delete('/api/profiles/:id', auth, wrap(async (req, res) => {
  await q('DELETE FROM profiles WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  res.json({ ok: true });
}));

app.post('/api/designs', auth, wrap(async (req, res) => {
  if (!req.body.spec || !PRICING.cats[req.body.spec.category]) return bad(res, 400, 'Invalid design');
  const r = (await q('INSERT INTO designs (user_id, spec) VALUES ($1,$2) RETURNING *', [req.user.sub, req.body.spec])).rows[0];
  res.json({ design: r });
}));

app.delete('/api/designs/:id', auth, wrap(async (req, res) => {
  await q('DELETE FROM designs WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  res.json({ ok: true });
}));

// ---------- orders + payments ----------
const orderOut = r => ({
  id: r.id, customer: r.customer_name, profileId: r.profile_id, profileName: r.profile_name, spec: r.spec, m: r.measurements,
  adj: r.adj, ref: r.ref, price: r.price, status: r.status, notes: r.notes, locked: r.locked, paymentStatus: r.payment_status,
  feedback: r.feedback, eta: r.eta, created: r.created_at, updated: r.updated_at, phone: r.phone,
});

async function notify(userId, orderId, title, body) {
  await q('INSERT INTO notifications (user_id, order_id, title, body) VALUES ($1,$2,$3,$4)', [userId, orderId, title, body]);
}

app.post('/api/orders', auth, wrap(async (req, res) => {
  const b = req.body, spec = b.spec;
  const amount = spec && price(spec);
  if (!amount) return bad(res, 400, 'Invalid design');
  if (!b.measurements || !b.measurements.chest) return bad(res, 400, 'Measurements are required');
  const u = (await q('SELECT * FROM users WHERE id=$1', [req.user.sub])).rows[0];
  const seq = (await q("SELECT nextval('order_seq') n")).rows[0].n;
  const id = 'DZ-' + seq;
  const days = (PRICING.cats[spec.category].days || 10) + 3;
  await q(`INSERT INTO orders (id,user_id,customer_name,profile_id,profile_name,spec,measurements,adj,ref,price,status,notes,locked,payment_status,eta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,'pending', (now() + ($13 || ' days')::interval)::date)`,
    [id, u.id, u.name || ('+' + u.phone), b.profileId || null, b.profileName || null, spec, b.measurements, b.adj || {}, b.ref || null, amount, (b.notes || '').slice(0, 500), !!b.locked, String(days)]);
  if (PAY_LIVE) {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(RZP_ID + ':' + RZP_SECRET).toString('base64') },
      body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt: id, notes: { order: id } }),
    });
    if (!r.ok) return bad(res, 502, 'Payment provider is not responding. Please try again');
    const rz = await r.json();
    await q('UPDATE orders SET rzp_order_id=$2 WHERE id=$1', [id, rz.id]);
    return res.json({ orderId: id, amount, payment: { mode: 'razorpay', keyId: RZP_ID, rzpOrderId: rz.id, amount: amount * 100, name: u.name, phone: u.phone } });
  }
  // Test mode: no payment provider configured, so the order is marked as a test payment.
  await confirmPaid(id, u.id, 'test-paid', 'TEST-' + Date.now());
  res.json({ orderId: id, amount, payment: { mode: 'test' } });
}));

async function confirmPaid(id, userId, status, ref) {
  await q("UPDATE orders SET payment_status=$2, payment_ref=$3, status=GREATEST(status,1), updated_at=now() WHERE id=$1", [id, status, ref]);
  await q('INSERT INTO order_events (order_id,status,note) VALUES ($1,1,$2)', [id, status]);
  await notify(userId, id, `Order ${id} confirmed`, 'Design approved and measurements confirmed. We will let you know when production starts.');
}

app.post('/api/orders/:id/pay/verify', auth, wrap(async (req, res) => {
  const o = (await q('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub])).rows[0];
  if (!o) return bad(res, 404, 'Order not found');
  if (!PAY_LIVE) return bad(res, 400, 'Payments are in test mode');
  const { razorpay_payment_id: pid, razorpay_order_id: oid, razorpay_signature: sig } = req.body;
  const expect = crypto.createHmac('sha256', RZP_SECRET).update(oid + '|' + pid).digest('hex');
  const sigOk = typeof sig === 'string' && sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig));
  if (oid !== o.rzp_order_id || !sigOk) {
    await q("UPDATE orders SET payment_status='failed' WHERE id=$1", [o.id]);
    return bad(res, 400, 'Payment could not be verified');
  }
  await confirmPaid(o.id, o.user_id, 'paid', pid);
  res.json({ ok: true });
}));

app.post('/api/orders/:id/feedback', auth, wrap(async (req, res) => {
  const r = await q('UPDATE orders SET feedback=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.sub, req.body.feedback || {}]);
  if (!r.rows[0]) return bad(res, 404, 'Order not found');
  const needs = Object.values(req.body.feedback || {}).some(v => v !== 'Perfect');
  if (needs) await notify(req.user.sub, req.params.id, 'Free alteration booked', 'Our team will call you to arrange a doorstep pickup.');
  res.json({ ok: true });
}));

app.post('/api/notifications/read', auth, wrap(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.sub]);
  res.json({ ok: true });
}));

// ---------- workshop (staff) ----------
app.get('/api/admin/orders', auth, staffOnly, wrap(async (req, res) => {
  const { rows } = await q(`SELECT o.*, u.phone FROM orders o JOIN users u ON u.id=o.user_id
     WHERE o.payment_status <> 'pending' ORDER BY o.created_at DESC LIMIT 500`);
  res.json({ orders: rows.map(orderOut) });
}));

app.patch('/api/admin/orders/:id', auth, staffOnly, wrap(async (req, res) => {
  const st = Number(req.body.status);
  if (!Number.isInteger(st) || st < 0 || st >= STATUSES.length) return bad(res, 400, 'Invalid status');
  const o = (await q('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, st])).rows[0];
  if (!o) return bad(res, 404, 'Order not found');
  await q('INSERT INTO order_events (order_id,status,by_user) VALUES ($1,$2,$3)', [o.id, st, req.user.sub]);
  await notify(o.user_id, o.id, `${o.id}: ${STATUSES[st]}`, st === 5 ? 'Your order is on its way.' : st === 6 ? 'Delivered. Tell us how it fits!' : `Your order is now at "${STATUSES[st]}".`);
  res.json({ order: orderOut(o) });
}));

app.get('/api/admin/orders/:id/events', auth, staffOnly, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM order_events WHERE order_id=$1 ORDER BY at', [req.params.id]);
  res.json({ events: rows });
}));

app.get('/api/admin/customers', auth, staffOnly, wrap(async (req, res) => {
  const { rows } = await q(`SELECT u.id, u.phone, u.name, u.created_at,
      (SELECT count(*) FROM profiles p WHERE p.user_id=u.id)::int AS profiles,
      COALESCE(o.n,0)::int AS orders, COALESCE(o.spent,0)::int AS spent, o.last_order
    FROM users u LEFT JOIN (SELECT user_id, count(*) n, sum(price) spent, max(created_at) last_order
      FROM orders WHERE payment_status<>'pending' GROUP BY user_id) o ON o.user_id=u.id
    WHERE u.role='customer' ORDER BY o.last_order DESC NULLS LAST, u.created_at DESC LIMIT 500`);
  res.json({ customers: rows });
}));

app.get('/api/admin/fabrics', auth, staffOnly, wrap(async (req, res) => {
  res.json({ fabrics: (await q('SELECT * FROM fabrics ORDER BY name, color')).rows });
}));
app.post('/api/admin/fabrics', auth, staffOnly, wrap(async (req, res) => {
  const b = req.body; if (!b.name || !b.color) return bad(res, 400, 'Name and colour are required');
  const r = await q(`INSERT INTO fabrics (name,color,stock_m,reorder_m,cost_per_m) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (name,color) DO UPDATE SET stock_m=EXCLUDED.stock_m, reorder_m=EXCLUDED.reorder_m, cost_per_m=EXCLUDED.cost_per_m, updated_at=now() RETURNING *`,
    [b.name, b.color, +b.stock_m || 0, +b.reorder_m || 10, +b.cost_per_m || 0]);
  res.json({ fabric: r.rows[0] });
}));
app.patch('/api/admin/fabrics/:id', auth, staffOnly, wrap(async (req, res) => {
  const b = req.body;
  const r = await q(`UPDATE fabrics SET stock_m=COALESCE($2,stock_m), reorder_m=COALESCE($3,reorder_m), cost_per_m=COALESCE($4,cost_per_m), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.stock_m ?? null, b.reorder_m ?? null, b.cost_per_m ?? null]);
  res.json({ fabric: r.rows[0] });
}));
app.delete('/api/admin/fabrics/:id', auth, staffOnly, wrap(async (req, res) => {
  await q('DELETE FROM fabrics WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));

app.get('/api/admin/reports', auth, staffOnly, wrap(async (req, res) => {
  const paid = "payment_status <> 'pending'";
  const [byStatus, totals, daily, cats, late] = await Promise.all([
    q(`SELECT status, count(*)::int n FROM orders WHERE ${paid} GROUP BY status`),
    q(`SELECT count(*)::int orders, COALESCE(sum(price),0)::int revenue, COALESCE(avg(price),0)::int aov,
        COALESCE(avg(CASE WHEN locked THEN 1 ELSE 0 END),0)::float lock_rate,
        count(*) FILTER (WHERE feedback IS NOT NULL)::int feedback_n,
        count(*) FILTER (WHERE feedback IS NOT NULL AND NOT (feedback::text LIKE '%Tight%' OR feedback::text LIKE '%Loose%'))::int perfect_n
       FROM orders WHERE ${paid} AND created_at > now() - interval '30 days'`),
    q(`SELECT to_char(d,'YYYY-MM-DD') AS "day", COALESCE(count(o.id),0)::int n, COALESCE(sum(o.price),0)::int revenue
       FROM generate_series(current_date - 13, current_date, interval '1 day') d
       LEFT JOIN orders o ON o.created_at::date = d::date AND o.${paid} GROUP BY d ORDER BY d`),
    q(`SELECT spec->>'category' cat, count(*)::int n, sum(price)::int revenue FROM orders WHERE ${paid} GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT count(*)::int n FROM orders WHERE ${paid} AND status < 5 AND eta < current_date`),
  ]);
  res.json({ byStatus: byStatus.rows, totals: totals.rows[0], daily: daily.rows, categories: cats.rows, late: late.rows[0].n, statuses: STATUSES });
}));

app.use((err, req, res, next) => { console.error(err); bad(res, 500, 'Something went wrong on our side. Please try again'); });

migrate().then(() => app.listen(PORT, () => console.log(`Darzi API on :${PORT} · SMS ${SMS_LIVE ? 'live' : 'test mode'} · payments ${PAY_LIVE ? 'live' : 'test mode'}`)))
  .catch(e => { console.error('Database setup failed', e); process.exit(1); });
