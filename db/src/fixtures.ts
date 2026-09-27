// Realistic demo content for the seed: a payments product at an Indian fintech ("Paytrail").
// Kept separate from seed.ts so the insertion logic reads without scrolling past phrase lists.

/** Deterministic PRNG (mulberry32), so every developer's seed produces the same keys and titles. */
export function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PEOPLE = [
  // Keycloak accounts (infra/local/keycloak) — these can sign in.
  { email: 'anita.desai@paytrail.in', name: 'Anita Desai', role: 'org_admin' },
  { email: 'rahul.verma@paytrail.in', name: 'Rahul Verma', role: 'project_admin' },
  { email: 'sneha.iyer@paytrail.in', name: 'Sneha Iyer', role: 'test_lead' },
  { email: 'aarav.mehta@paytrail.in', name: 'Aarav Mehta', role: 'tester' },
  { email: 'aditya.chauhan@paytrail.in', name: 'Aditya Chauhan', role: 'viewer' },
  // Colleagues without a login in the local realm: owners, assignees, reviewers.
  { email: 'priya.nair@paytrail.in', name: 'Priya Nair', role: 'tester' },
  { email: 'rohan.gupta@paytrail.in', name: 'Rohan Gupta', role: 'tester' },
  { email: 'ananya.rao@paytrail.in', name: 'Ananya Rao', role: 'tester' },
  { email: 'karan.malhotra@paytrail.in', name: 'Karan Malhotra', role: 'test_lead' },
  { email: 'meera.joshi@paytrail.in', name: 'Meera Joshi', role: 'tester' },
  { email: 'arjun.reddy@paytrail.in', name: 'Arjun Reddy', role: 'tester' },
  { email: 'neha.kulkarni@paytrail.in', name: 'Neha Kulkarni', role: 'tester' },
  { email: 'kavya.menon@paytrail.in', name: 'Kavya Menon', role: 'tester' },
] as const;

/** Functionality tree for the PAY project; each leaf lists the behaviours its cases cover. */
export const MODULE_TREE: Record<string, Record<string, string[]>> = {
  Checkout: {
    Cart: [
      'cart total with GST applied',
      'cart update when an item goes out of stock',
      'coupon code stacking rules',
    ],
    Address: [
      'PIN code lookup for serviceable areas',
      'saved address selection',
      'address validation for the landmark field',
    ],
    'Payment selection': [
      'payment method order by last used',
      'disabled methods for amounts under ₹10',
      'retry payment after a failed attempt',
    ],
  },
  UPI: {
    Collect: [
      'collect request to a valid VPA',
      'collect request expiry after 5 minutes',
      'collect request above ₹1,00,000',
      'collect request when the payer bank is down',
    ],
    Intent: [
      'intent flow opening installed UPI apps',
      'intent callback after app switch',
      'intent flow with no UPI app installed',
    ],
    'Autopay mandates': [
      'mandate creation with monthly frequency',
      'mandate pause and resume',
      'mandate revoke from the payer app',
      'pre-debit notification 24 hours before charge',
    ],
    'QR scan': ['dynamic QR with a fixed amount', 'QR expiry after timeout', 'scan of a static merchant QR'],
  },
  Cards: {
    'Add card': [
      'card number Luhn validation',
      'card network detection for RuPay',
      'expiry date in the past',
    ],
    'Saved cards': [
      'tokenised card display with last 4 digits',
      'delete a saved card',
      'CVV-less payment on a tokenised card',
    ],
    '3-D Secure': [
      'OTP page redirect for 3-D Secure',
      '3-D Secure timeout handling',
      'frictionless flow for low-risk payments',
    ],
  },
  'Net banking': {
    'Bank list': ['popular banks shown first', 'bank search by name', 'bank downtime banner'],
    'Redirect flow': [
      'return URL after bank success',
      'user cancelling on the bank page',
      'double submit on the bank redirect',
    ],
  },
  Wallet: {
    'Top-up': [
      'wallet top-up with UPI',
      'top-up limit for minimum-KYC users',
      'top-up failure refund to source',
    ],
    Transfers: ['wallet-to-wallet transfer', 'transfer to a blocked account', 'transfer history pagination'],
  },
  Refunds: {
    'Full refund': [
      'full refund to the original method',
      'refund on a cancelled order',
      'refund SMS to the customer',
    ],
    'Partial refund': ['partial refund amount validation', 'multiple partial refunds up to the paid amount'],
    'Refund status': [
      'refund status timeline',
      'refund ARN shown to the customer',
      'refund stuck beyond 7 days',
    ],
  },
  Auth: {
    Login: [
      'login with a registered mobile number',
      'login lockout after 5 wrong attempts',
      'login with an expired password',
    ],
    OTP: [
      'OTP auto-read on Android',
      'OTP retry limit',
      'OTP resend after 30 seconds',
      'OTP entry with a pasted value',
    ],
    Session: [
      'session timeout after 15 minutes idle',
      'concurrent sessions on two devices',
      'logout clearing every session',
    ],
  },
  KYC: {
    'PAN verification': [
      'PAN format validation',
      'PAN name mismatch handling',
      'PAN verification when NSDL is slow',
    ],
    'Aadhaar eKYC': ['Aadhaar OTP consent screen', 'masked Aadhaar number display', 'eKYC failure retry'],
    'Video KYC': ['video KYC slot booking', 'video KYC agent disconnect', 'liveness check in low light'],
  },
  Settlements: {
    Payouts: ['T+1 payout schedule', 'payout on a bank holiday', 'payout hold for a flagged merchant'],
    Reconciliation: ['reconciliation report for settled transactions', 'mismatch flag for unsettled amounts'],
  },
  Notifications: {
    SMS: ['transaction SMS with DLT template', 'SMS for a failed payment', 'SMS in Hindi'],
    Email: ['payment receipt email', 'email unsubscribe link', 'email rendering in Outlook'],
  },
  Reports: {
    'Transaction export': [
      'CSV export of 1 lakh transactions',
      'export with a custom date range',
      'export emailed when ready',
    ],
    Dashboards: [
      'merchant dashboard GMV widget',
      'dashboard filter by payment method',
      'dashboard in IST vs UTC',
    ],
  },
};

export const VERBS = ['Verify', 'Validate', 'Check', 'Ensure'];
export const CONDITIONS = [
  'on Chrome 128',
  'on Safari 17',
  'on Android 14',
  'on iOS 17',
  'on slow 3G',
  'after a session timeout',
  'with Hindi locale',
  'for a first-time user',
  'when retried twice',
  'with the minimum amount ₹1',
  'at the 23:59 settlement cutoff',
  'with a screen reader',
  '',
  '',
  '',
];
export const LABELS = [
  'smoke',
  'regression',
  'p0-flow',
  'rbi-compliance',
  'release-4.18',
  'hindi',
  'a11y',
  'mobile-web',
];
export const TYPES = [
  'Functional',
  'Functional',
  'Functional',
  'Regression',
  'Negative',
  'End-to-end',
  'Accessibility',
];
export const CONFIGS = [
  'Chrome 128 · Win 11',
  'Safari 17 · macOS 14',
  'Android 14 · Pixel 8',
  'iOS 17 · iPhone 15',
];

const ACTIONS = [
  'Enter the test data from the data set and submit',
  'Wait for the status to update on the screen',
  'Switch to the payer app and approve the request',
  'Refresh the page and reopen the transaction',
  'Open the transaction details from the merchant dashboard',
];
const EXPECTED = [
  'Request is created with status PENDING',
  'Status changes to SUCCESS within 10 seconds',
  'Amount and reference number match the order',
  'Webhook payment.captured is sent to the merchant',
  'Error explains the failure and offers a retry',
];

export interface SeedStep {
  action: string;
  expected: string;
  data: string;
}

/** Builds 4–6 plausible steps for one behaviour. */
export function makeSteps(rand: () => number, leaf: string, behaviour: string): SeedStep[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const steps: SeedStep[] = [
    {
      action: 'Sign in to the Paytrail merchant dashboard as “QA Test Store”',
      expected: 'Dashboard loads within 3 seconds',
      data: 'merchant: qa-test-store',
    },
    { action: `Go to ${leaf}`, expected: `${leaf} opens with no console errors`, data: '' },
    {
      action: `Start the flow for: ${behaviour}`,
      expected: pick(EXPECTED),
      data: `vpa: qa.payer@okaxis · amount: ₹${Math.floor(rand() * 4000) + 1}`,
    },
  ];
  const extra = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < extra; i++) steps.push({ action: pick(ACTIONS), expected: pick(EXPECTED), data: '' });
  return steps;
}
