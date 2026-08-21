# Security

## Threat model

Active mode gives every allowlisted phone number autonomous Codex access to the host with `danger-full-access`, approval policy `never`, network access, and live web search. The allowlist is the trust boundary. Specifically:

- **The sender is trusted by phone number.** SMS sender spoofing and SIM swaps are real; iMessage is harder to spoof. Keep the allowlist to yourself and prefer iMessage.
- **The webhook is protected by a shared secret** (`sb-signing-secret` header, constant-time compared), not a cryptographic signature. Anyone holding the secret can inject messages as an allowlisted sender. Treat it like a password; rotate it if a tunnel or proxy may have logged it.
- **Codex runs as your user.** It can read the config file and anything else you can. Excluding Sendblue keys from its environment is hygiene, not a boundary. Run the daemon as a separate, non-admin macOS or Linux user if you want a real boundary.
- **Web content is untrusted.** Codex has live web search and can run any browser tool you install. Instructions on a page could steer it. The managed instructions say to treat such content as data and to confirm consequential external actions with you, but that is a prompt-level defense. Be deliberate about which tools and accounts you give it.
- **Routines and `AGENTS.md` persist.** A compromised turn could schedule future work or edit the operator section of `AGENTS.md`. Review both occasionally (`what routines do I have`; open the file).

What the host enforces regardless of model output: the action envelope is re-validated with strict schemas, reactions can only target the triggering message, local files can only be sent from the workspace or media directory, inbound media is only downloaded from Sendblue hosts over HTTPS with size and redirect limits, and malformed output is rendered as bounded text, never executed.

## What leaves the machine

Texts, attachments, and phone numbers go to Sendblue. Prompts, `AGENTS.md`, images, tool output, and web searches go to OpenAI through the Codex SDK under your ChatGPT login. Nothing else.

## Reporting

Use GitHub's private vulnerability reporting on this repository, or email `aliabassi1@gmail.com`. Do not open a public issue with credentials, phone numbers, webhook payloads, or exploit details.
