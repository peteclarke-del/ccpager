# Security policy

ccpager is a local HTTP gateway that sits between Claude Code and the
Anthropic API. It sees every request, including your API key or OAuth token in
the forwarded headers, so security reports are welcome even though the default
deployment listens only on loopback for a single user.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Current `main` branch | Yes |
| Latest published release | Yes |
| Older tags and unmaintained branches | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
[Report a vulnerability](https://github.com/peteclarke-del/ccpager/security/advisories/new)
workflow. If that workflow is unavailable, contact the repository owner
privately using the address on the maintainer's GitHub profile. Include the
affected version or commit, host distribution and Node.js version, a minimal
reproduction that contains no credentials, and sanitised logs.

You should receive an acknowledgement within five working days. Disclosure
timing will be coordinated with the reporter. These are response targets, not
a service-level agreement.

## Security boundaries

Reports are especially useful for:

- the gateway becoming reachable from other hosts, or accepting requests from
  other users on the same machine;
- credentials, request bodies or responses being written to the log or stats
  files, or to any location other than the upstream API;
- a request being forwarded anywhere other than the configured upstream;
- a transform that changes the meaning of a conversation in a way the user
  did not ask for, or that strips or alters tool-use ids, signatures or
  assistant turns;
- the settings or desktop-entry writers touching files outside
  `~/.ccpager`, `~/.claude/settings.json`, the systemd user unit and the
  user's application menu;
- vulnerable dependencies.

Use a disposable API key for research and do not test against accounts or
data you do not own. This project does not operate a bug bounty.
