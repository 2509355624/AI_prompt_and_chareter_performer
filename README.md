# AI Art Prompt Generator

A web-based tool to generate detailed AI image prompts using local Ollama models or external APIs (OpenAI, DeepSeek, etc.).

## Features
- **Local Privacy**: Use Ollama locally for free, private generation.
- **API Support**: Connect to OpenAI, DeepSeek, or any OpenAI-compatible API.
- **Clean UI**: Simple, responsive interface.
- **One-Click Copy**: Easily copy generated prompts.

## Prerequisites
- [Node.js](https://nodejs.org/) installed.
- (Optional) [Ollama](https://ollama.com/) installed and running for local models.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser to:
   [http://localhost:3000](http://localhost:3000)

## Usage

1. **Configure**: Click the "Configuration" header to expand settings.
   - Select "Local Ollama" or "OpenAI / Custom API".
   - Set the Model Name (e.g., `llama3`, `deepseek-r1`).
   - For APIs, enter your Key and Base URL.
2. **Generate**: Enter a topic (e.g., "A futuristic cat") and click Generate.
3. **Copy**: Click "Copy" on any result to use it in Midjourney, Stable Diffusion, etc.
