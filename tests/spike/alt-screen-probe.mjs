#!/usr/bin/env node
/**
 * Alternate-screen spike probe (ticket e2e-testing 25 / tui-refactor 12).
 *
 * Renders a minimal fixed-viewport Ink app in the alternate screen:
 *  - a main-screen marker is printed BEFORE entering, so the test can prove
 *    the primary buffer (scrollback) survives the alt-screen session
 *  - the body shows a scroll window over a long transcript, driven by
 *    up/down keys (the core of a fullscreen transcript viewport)
 *  - 'q' unmounts and restores the primary screen
 */
import React, { useState, useEffect } from 'react';
import { Box, Text, render, useInput, useStdout } from 'ink';

const LINES = Array.from({ length: 60 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);

function Probe() {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows ?? 24);
  const [offset, setOffset] = useState(0);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows ?? 24);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const viewport = Math.max(3, rows - 3); // header + footer + editor
  const maxOffset = Math.max(0, LINES.length - viewport);

  useInput((input, key) => {
    if (input === 'q') setExited(true);
    if (key.downArrow) setOffset((o) => Math.min(maxOffset, o + 1));
    if (key.upArrow) setOffset((o) => Math.max(0, o - 1));
  });

  useEffect(() => {
    if (exited) process.exit(0);
  }, [exited]);

  return React.createElement(
    Box,
    { flexDirection: 'column', height: rows },
    React.createElement(Text, { color: 'cyan' }, `alt-probe viewport=${viewport} offset=${offset}/${maxOffset}`),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      LINES.slice(offset, offset + viewport).map((line) =>
        React.createElement(Text, { key: line }, line),
      ),
    ),
    React.createElement(Text, { color: 'gray', dimColor: true }, 'q quit · up/down scroll'),
  );
}

process.stdout.write('MAIN-SCREEN-MARKER\n');
// interactive: true is required: Ink ignores alternateScreen when it detects
// CI or a non-TTY stdout (see render.d.ts).
render(React.createElement(Probe), { alternateScreen: true, interactive: true });
