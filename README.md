# voice-agent

AI phone agent for DIGILUX clinics — answers inbound Telnyx calls, talks
to the patient over the phone, and books appointments via the existing
`claude-agent` HTTP API.

| Phase | Capability | Status |
|-------|-----------|--------|
| 1     | Answer call → speak Hebrew greeting → hang up. One Telnyx number per clinic. | ✅ implemented |
| 2     | Bidirectional real-time audio with OpenAI Realtime API. | ⏳ planned |
| 3     | AI uses `get_available_slots` / `create_appointment` / `reschedule` / `cancel` to actually book during the call. | ⏳ planned |

## Architecture (Phase 1)

```
PSTN caller → Telnyx number → Telnyx Call Control webhook → voice-agent
                                                                ↓
                                                  Supabase (call_sessions row)
                                                                ↓
                            Telnyx REST API ← speak / hangup commands
```

## Local development

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_API_KEY
npm install
npm run dev
```

The server listens on `PORT` (default `3100`). For local Telnyx webhook
testing, tunnel with `ngrok http 3100` and point your Telnyx Call
Control Application's webhook URL at `https://<your-ngrok>/api/telnyx/webhook`.

## Deployment (Railway)

1. Create a new Railway project from this folder.
2. Add the variables from `.env.example` (Supabase keys, `TELNYX_API_KEY`,
   `TELNYX_PUBLIC_KEY`). Railway sets `PORT` automatically.
3. After first deploy, copy the Railway domain into `PUBLIC_HOSTNAME` —
   it's used by Phase 2 to build the wss:// audio bridge URL.
4. Health check: `GET /health` returns `{ ok: true, service: "voice-agent" }`.

## Clinic onboarding (one-time per clinic)

1. **Buy a Telnyx number.** Mission Control → Numbers → Search & Buy.
2. **Create a Call Control Application.** Mission Control → Call Control →
   Applications → New. Webhook URL =
   `https://<voice-agent-domain>/api/telnyx/webhook`. Webhook API Version = 2.
3. **Assign the number to the application.** Mission Control → Numbers →
   click the number → Connection = the new Call Control App.
4. **Run the SQL mapping** (replace placeholders):
   ```sql
   INSERT INTO telnyx_numbers (clinic_id, phone_number, telnyx_connection_id)
   VALUES (<CLINIC_ID>, '+972XXXXXXXXX', '<CALL_CONTROL_APP_ID>');
   ```
5. **(Optional) Set a transfer destination** for the future
   `transfer_to_human` tool:
   ```sql
   UPDATE clinics_digilux SET transfer_phone_number = '+972XXXXXXXXX' WHERE id = <CLINIC_ID>;
   ```
6. **Customise the greeting.** The Hebrew greeting comes from
   `clinics_digilux.welcome_message_he`. If unset, a generic default is
   used.
7. **Test.** Dial the number — you should hear the greeting and the
   call should end automatically. Row appears in `call_sessions` with
   `status='completed'`.

## What Phase 1 does NOT do

- No real-time conversation. The caller hears the greeting and the call ends.
- No booking. The AI tools aren't wired yet.
- No recording / transcript. Empty `call_messages` until Phase 2.
- No dashboard UI. Inspect calls in Supabase Studio for now.

Phase 2 will swap the `speak → hangup` block in `routes/telnyxWebhook.js`
for `telnyx.startMediaStreaming(...)` pointing at a new WS handler that
bridges audio to OpenAI Realtime.
