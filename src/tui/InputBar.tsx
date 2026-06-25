import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/** Props for the InputBar component. */
export interface InputBarProps {
  /** Callback when the user submits input by pressing Enter. */
  onSubmit: (input: string) => void;
  /** Whether the agent is currently streaming a response. */
  isStreaming: boolean;
}

/**
 * Text input bar for user messages.
 *
 * Displays a working directory prefix and handles keyboard input.
 * Enter submits, Ctrl+C exits, Backspace deletes.
 */
export function InputBar({ onSubmit, isStreaming }: InputBarProps): React.ReactElement {
  const [input, setInput] = useState('');

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      process.exit(0);
    }

    if (key.return) {
      if (input.trim() && !isStreaming) {
        onSubmit(input);
        setInput('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    // Ignore other control sequences
    if (key.ctrl || key.meta) {
      return;
    }

    // Append printable characters
    if (inputChar && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setInput((prev) => prev + inputChar);
    }
  });

  const cwd = process.cwd();
  const promptColor = isStreaming ? 'gray' : 'green';
  const placeholder = isStreaming ? '(waiting for response...)' : 'Type a message...';

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray" dimColor>{cwd}</Text>
      <Text color="white"> &gt; </Text>
      {input.length > 0 ? (
        <Text color="white">{input}</Text>
      ) : (
        <Text color="gray" dimColor>{placeholder}</Text>
      )}
      <Text color={promptColor}> </Text>
    </Box>
  );
}
