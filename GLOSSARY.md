# Glossary

- **piz** — This maintained ZCode fork and its installed CLI command.
- **OSC 7501** — Terminal program-status protocol (mitchellh.com/writing/program-status-osc7501). A program emits `ESC ] 7501 ; state=…[:kind=…][:app=…][:msg=<base64>] ESC \` on its own output stream; states are idle/working/done/blocked/error. Terminals and multiplexers may render them (badges/notifications); terminals that don't know the sequence ignore it.
