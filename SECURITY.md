# Security

## Reporting a vulnerability

Please do not report security problems in public issues.

Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. You will get a reply as soon as possible, and a fix will be released before the details are made public.

## Areas that matter most

Sumi runs local tools and, if you use the AI panel, coding agents with access to your files. Reports about these are especially welcome:

- An agent changing files without the permission prompt it should show
- Opening a document or a folder causing commands to run that you did not expect
- Links or content from an agent or a document escaping the app's sandbox
- Secrets from your shell environment reaching places they should not

Only the latest version on `main` is supported.
