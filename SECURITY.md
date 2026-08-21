# Security

Active mode gives allowlisted senders autonomous Codex access to the host with `danger-full-access`, approval policy `never`, network access, and live web search. Use a dedicated Sendblue line, keep the allowlist narrow, protect the private JSON config as a secret, and run under a non-admin macOS user when possible.

Codex authentication comes from `codex login` using a ChatGPT subscription. The daemon does not require or store an OpenAI API key, and Sendblue credentials are excluded from the Codex child environment. Note that a same-user process can still read the config file; the allowlist is the real trust boundary.

Report vulnerabilities privately to `aliabassi1@gmail.com`. Do not open a public issue with credentials, phone numbers, webhook payloads, or exploit details.
