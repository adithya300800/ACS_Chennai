// Test what happens with empty/invalid API key
import { Resend } from 'resend';

console.log('=== Test 1: Valid key ===');
const validResend = new Resend('REDACTED_USE_RESEND_API_KEY_ENV');
const r1 = await validResend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Valid key test',
  html: '<p>Test</p>'
});
console.log('Valid result:', r1.error ? r1.error : 'SUCCESS - ' + r1.data?.id);

console.log('\n=== Test 2: Empty key ===');
const emptyResend = new Resend('');
const r2 = await emptyResend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Empty key test',
  html: '<p>Test</p>'
});
console.log('Empty result:', r2.error ? JSON.stringify(r2.error) : 'SUCCESS - ' + r2.data?.id);

console.log('\n=== Test 3: Undefined key ===');
const undefinedResend = new Resend(undefined);
const r3 = await undefinedResend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Undefined key test',
  html: '<p>Test</p>'
});
console.log('Undefined result:', r3.error ? JSON.stringify(r3.error) : 'SUCCESS - ' + r3.data?.id);

console.log('\n=== Test 4: env var not set (simulated) ===');
// This simulates what happens when VITE_RESEND_API_KEY is not set
const envResend = new Resend(process.env.VITE_RESEND_API_KEY || '');
console.log('Key used:', process.env.VITE_RESEND_API_KEY || '(empty)');
const r4 = await envResend.emails.send({
  from: 'info@acschennai.com',
  to: 'info@acschennai.com',
  subject: 'Env var test',
  html: '<p>Test</p>'
});
console.log('Env result:', r4.error ? JSON.stringify(r4.error) : 'SUCCESS - ' + r4.data?.id);