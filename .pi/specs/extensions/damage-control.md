# Extension Spec: Damage Control

## 1. Name

`damage-control`

## 2. Description

The `damage-control` extension enhances Pi's safety by intercepting potentially dangerous `bash` commands and requiring explicit user confirmation before execution. This prevents accidental data loss or system modifications, especially when the LLM suggests such commands.

## 3. Key Features

*   **Command Interception:** Intercepts all calls to the built-in `bash` tool.
*   **Dangerous Command Detection:** Identifies commands based on a configurable list of patterns (regex or exact matches).
*   **User Confirmation Prompt:** Presents a clear, interactive prompt to the user asking for confirmation before executing a flagged command.
*   **Configurable Blacklist:** Allows users to define custom lists of dangerous commands or patterns.
*   **Whitelist/Bypass Option:** Potentially allow specific commands or a special prefix/suffix to bypass the confirmation (e.g., `bash:!rm -rf /` or `/!rm -rf /` could indicate "I know what I'm doing, execute without asking"). (Initial implementation might omit this but it's a good future consideration).
*   **Contextual Information:** The confirmation prompt should display the full command to be executed.

## 4. Technical Design (High-Level)

The extension will be implemented as a TypeScript module that leverages Pi's Extension API.

### 4.1. `onToolCode` Event Listener

The primary mechanism for interception will be registering an `onToolCode` event listener or overriding the `bash` tool itself.

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("tool_code", async (event, ctx) => {
    // Check if the tool being called is 'bash'
    if (event.toolName === "bash") {
      const command = event.toolArgs.command;
      if (isDangerousCommand(command)) {
        // Halt execution, prompt user
        const confirmed = await ctx.interact.confirm(
          `WARNING: The command \\`${command}\` is potentially dangerous. Do you want to execute it? (y/N)`
        );

        if (!confirmed) {
          // Prevent the original bash tool from running
          ctx.cancelToolCall();
          ctx.display.write("Command execution cancelled by user.");
          return;
        }
      }
    }
    // Allow other tools or non-dangerous bash commands to proceed
    // If ctx.cancelToolCall() is not called, the original tool call will proceed eventually.
  });
}
```

### 4.2. `isDangerousCommand` Function

This internal helper function will check the incoming `command` string against a list of predefined or user-configured dangerous patterns.

**Example Patterns:**

*   `rm -rf` (recursive force delete)
*   `sudo` (root privileges)
*   `mkfs` (make filesystem)
*   `dd if=/dev/zero of=/dev/sda` (disk wipe)
*   `:> file` (truncate file in some shells)
*   `mv file /dev/null` (move to null)

These patterns could be stored in the extension's internal state or loaded from a configuration file. Regular expressions would be ideal for flexible matching.

### 4.3. User Interaction (`ctx.interact.confirm`)

The `ctx.interact.confirm` method will be used to present a blocking prompt to the user, awaiting a `y` or `n` input.

### 4.4. Configuration

The list of dangerous commands should be configurable by the user. This could be done via:
*   A `settings.json` entry under a special `damageControl` key in project or global settings.
*   A dedicated command like `/damage-control:add-pattern "pattern"`.

## 5. User Experience (UX)

When a dangerous command is detected:

1.  The agent's output will pause.
2.  A prominent warning message will appear in the Pi terminal, for example:
    ```
    🚨 WARNING: The command `rm -rf /` is potentially dangerous.
    Do you want to execute it? (y/N)
    ```
3.  The user must type `y` (or potentially `yes`) and press Enter to confirm, or `n` (or `no`) to cancel.
4.  If confirmed, the command proceeds as usual.
5.  If cancelled, a message like "Command execution cancelled by user." is displayed, and the agent continues its thought process without running the command.

## 6. Configuration Example

Users can define custom dangerous patterns in their `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "damageControl": {
    "enabled": true,
    "dangerousPatterns": [
      "rm -rf\\s+",
      "sudo\\s+",
      "mkfs\\.",
      "dd\\s+if=",
      "format\\s+"
    ]
  }
}
```

## 7. Future Considerations

*   **Audit Logging:** Log all blocked and confirmed dangerous commands for review.
*   **Smart Recognition:** Use a small local LLM or heuristics to identify unexpected dangerous commands beyond static patterns.
*   **Per-Project Policies:** Allow projects to enforce stricter or custom damage control policies.
*   **Timeout:** Automatically cancel if no user input within a certain time.
*   **Escape Hatch:** A global configuration to temporarily disable damage control for advanced users in known safe environments.
