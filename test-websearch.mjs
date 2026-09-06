import { createWebSearchTool } from './src/tools/web-search.js';

async function test() {
  try {
    const tool = createWebSearchTool();
    console.log('Tool name:', tool.name);
    console.log('Tool description:', tool.description);
    
    // Test the tool
    const result = await tool.execute({ query: 'test' }, {
      workingDirectory: process.cwd(),
      abortSignal: new AbortController().signal,
    });
    
    console.log('Result:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

test();