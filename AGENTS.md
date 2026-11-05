## Code formatting

- Prefer readable multiline formatting over compact one-line code.
- Put decorators with multiple options, object literals, union types with many alternatives, and callback bodies on multiple lines.
- Write each statement on its own line.
- Expand conditional blocks with braces onto multiple lines.
- Follow the project's formatter configuration.
- Do not reformat unrelated code unless requested.

## Scope and clarification

- Browser and Android must share the same UI and behavior unless explicitly requested otherwise.
- Keep platform-specific Bluetooth, permissions, and lifecycle implementations where necessary.
- Ask for clarification when a requirement is ambiguous. Do not silently narrow its scope.
- Preserve existing user changes and manual documentation edits.

## Verification and delivery

- Run checks relevant to the change. Do not repeat successful checks without a reason.
- Do not commit, push, or create release archives unless explicitly requested.
- Report checks that could not run separately from successful checks.

## Communication

- Explain code in Russian unless another language is requested.
- When discussing a file, provide its repository-relative path.
- Explain code step by step; do not start knowledge quizzes unless requested.