// Private TLS recording origin. Never prints request bodies or credentials.
const fs = require('node:fs');
const https = require('node:https');
const { respond } = require('./gateway.cjs');
const fixture = JSON.parse(fs.readFileSync('/fixture/expected'));
https
	.createServer(
		{ key: fs.readFileSync('/fixture/key.pem'), cert: fs.readFileSync('/fixture/cert.pem') },
		async (req, res) => {
			let body = '';
			for await (const chunk of req) body += chunk;
			const refuse = () => {
				res.writeHead(401);
				res.end();
			};
			if (req.headers.host === 'auth.openai.com' && req.url === '/oauth/token' && req.method === 'POST') {
				if (new URLSearchParams(body).get('refresh_token') !== fixture.refresh) return refuse();
				console.log('refresh');
				res.setHeader('content-type', 'application/json');
				return res.end(
					JSON.stringify({ access_token: fixture.rotated, refresh_token: fixture.next, expires_in: 3600 }),
				);
			}
			const subscription = req.headers.host === 'chatgpt.com';
			if (subscription && req.headers['chatgpt-account-id'] !== 'fixture-account') return refuse();
			if (req.headers.authorization !== 'Bearer ' + (subscription ? fixture.rotated : fixture.key)) return refuse();
			const base = subscription ? '/backend-api/codex' : '/v1';
			if (
				req.url !== base + '/responses' &&
				req.url !== base + (subscription ? '/models?client_version=0.171.0' : '/models')
			)
				return refuse();
			console.log('authorized', req.method, req.url);
			if (req.url.endsWith('/responses') && fs.existsSync('/tmp/hold')) {
				console.log('holding');
				return;
			}
			respond(req, res);
		},
	)
	.listen(443);
