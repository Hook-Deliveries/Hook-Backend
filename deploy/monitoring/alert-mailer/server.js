const http = require('node:http');

const recipients = (process.env.ALERT_TO || '').split(',').map((email) => ({ email: email.trim() })).filter((r) => r.email);

async function send(alert) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.ALERT_FROM, name: 'Hook Alerts' },
      to: recipients,
      subject: alert.title || 'Hook alert',
      textContent: alert.message || JSON.stringify(alert, null, 2),
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      await send(JSON.parse(body || '{}'));
      res.writeHead(200).end('sent');
    } catch (error) {
      console.error(error.message);
      res.writeHead(502).end('failed');
    }
  });
}).listen(8080, () => console.log(`alert-mailer sending to ${recipients.map((r) => r.email).join(', ')}`));
