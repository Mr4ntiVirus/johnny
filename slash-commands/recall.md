Run this shell command and show me the output:

```bash
johnny recall $ARGUMENTS
```

If a memory was found, tell me briefly what context it represents and offer to load it with `/recall --switch $ARGUMENTS`. If `--switch` was passed, confirm the context swap is queued. If `--list` was passed, present the memories as a numbered list I can choose from.
