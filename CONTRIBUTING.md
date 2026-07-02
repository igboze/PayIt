Thank you for your interest in contributing to PayIT! We welcome bug reports, feature requests, documentation edits, and code contributions.

Getting started

- Fork the repository and create a feature branch named `feat/short-description` or a bugfix branch `fix/short-description`.
- Run the project locally (Windows PowerShell):

```powershell
./scripts/run-local.ps1
```

- Run unit and integration tests:

```bash
npm ci
npm test
```

Code style and commits

- Follow existing code style and naming conventions.
- Keep changes focused and provide a clear commit message.
- Write unit tests for new features or bug fixes when feasible.

Pull requests

- Open a PR against `main` with a clear description of the change and motivation.
- Link relevant issues and include testing steps.
- Maintain backwards compatibility where possible; document breaking changes.

Security

- Do not commit secrets (API keys, tokens, or private keys). Use environment variables or `.env` locally and add any machine-specific overrides to `.gitignore`.

Questions

- For design questions, open an issue and tag maintainers.
- If you want to contribute larger features, open an issue first to discuss the approach.
