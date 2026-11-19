# Glossary

- **piz** — This maintained ZCode fork and its installed CLI command.
- **dist-runtime** — The frozen runtime directory `apps/zcode-cli/packages/cli/dist-runtime/` that the installed `piz` wrapper execs. Only the promotion scripts write it; it carries the PROMOTED_* markers.
- **dispatch run** — A manual (`workflow_dispatch`) run of the `ci` workflow. The only run kind that assembles and uploads a `dist-runtime` artifact.
- **PROMOTED_FROM** — Installed runtime marker containing the original build commit, never relabeled to a later merge commit.
- **PROMOTED_ON** — Installed runtime marker containing the clean `main` commit whose Git tree was checked against the build at promotion time.
- **PROMOTED_CI_RUN** — Installed runtime marker containing the successful CI run that supplied the promoted artifact.
- **OSC 7501** — Terminal program-status protocol (mitchellh.com/writing/program-status-osc7501). A program emits `ESC ] 7501 ; state=…[:kind=…][:app=…][:msg=<base64>] ESC \` on its own output stream; states are idle/working/done/blocked/error. Terminals and multiplexers may render them (badges/notifications); terminals that don't know the sequence ignore it.
