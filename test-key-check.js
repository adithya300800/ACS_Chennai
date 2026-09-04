// Simulating what the browser does - testing the key check logic
const testCases = [
  { name: 'Valid key', key: 'REDACTED_USE_RESEND_API_KEY_ENV' },
  { name: 'Empty string', key: '' },
  { name: 'Undefined', key: undefined },
  { name: 'Missing env var', key: (typeof process !== 'undefined' && process.env ? process.env.VITE_RESEND_API_KEY : undefined) },
];

for (const test of testCases) {
  console.log(`\n=== Test: ${test.name} ===`);
  console.log('Key value:', test.key === undefined ? 'undefined' : `"${test.key}"`);

  if (!test.key) {
    console.log('Result: Would show error - "API key not configured"');
  } else {
    console.log('Result: Would proceed with sending email');
    // Actually try it
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(test.key);
      const result = await resend.emails.send({
        from: 'info@acschennai.com',
        to: 'info@acschennai.com',
        subject: `Test: ${test.name}`,
        html: '<p>Test</p>'
      });
      console.log('Success:', result.data?.id);
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
}