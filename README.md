# SayItAlarm — Backend

ElevenLabs proxy server for the [SayItAlarm](https://apps.apple.com/app/sayitalarm) iOS app.

## What it does

- Proxies ElevenLabs voice synthesis & cloning requests from the iOS app
- Keeps the ElevenLabs API key off the client device
- Rate-limits requests to prevent abuse

## Stack

- Node.js 18+ / Express
- ElevenLabs API (TTS + voice cloning)
- Deployed on Railway

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/synthesize` | Text-to-speech synthesis |
| POST | `/clone-voice` | Voice cloning |

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
npm start
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key |
| `APP_SECRET` | Shared secret with the iOS app |
| `PORT` | Server port (default: 3000) |

## Links

- [Support](https://anilaygunn.github.io/sayItAlarm-backend/)
- [Privacy Policy](https://anilaygunn.github.io/sayItAlarm-backend/PRIVACY.md)
