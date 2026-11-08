# leenkx

Find links sent between two WhatsApp numbers that are unacknowledged, i.e. received NO reply or reaction from the receiving party. 

Either participant can link their account by QR; sessions and chat history are stored locally with AES-256-GCM encryption.

## Run

Requires Node.js 20+.

```bash
npm install
npx pm2 start ecosystem.config.cjs
```

Open `http://localhost:3000`. 
For a domain, point `Caddyfile` at the server or `nginx` + `certbot`.
