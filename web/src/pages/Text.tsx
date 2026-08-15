import * as React from 'react';
import { MessageSquareText, SendHorizontal, Square } from 'lucide-react';
import { useResource, type BundleInfo } from '@/lib/api';
import { Button, Card, EmptyState, ErrorNote, Field, Select, Spinner, Textarea } from '@/components/ui';
import { Page } from '@/components/layout';
import { cn } from '@/lib/utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Text generation (requirement 3), streaming.
 *
 * Streaming is read from the raw `fetch` body rather than an `EventSource`,
 * because `EventSource` can only issue GET requests and a chat completion is a
 * POST with a body. The frames are still SSE, so they are split on the blank
 * line and each `data:` payload is parsed as it arrives.
 */
export function TextPage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=llm');
  const [model, setModel] = React.useState('');
  const [input, setInput] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const ready = (models.data?.models ?? []).filter((entry) => entry.ready);

  React.useEffect(() => {
    if (!model && ready.length > 0) setModel(ready[0].id);
  }, [ready, model]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || !model) return;

    const history = [...messages, { role: 'user' as const, content: prompt }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);
    setError(undefined);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/v1/llm/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: history, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; a partial frame stays in the
        // buffer until the rest of it arrives.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((part) => part.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const chunk = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (!delta) continue;
            setMessages((current) => {
              const next = [...current];
              next[next.length - 1] = {
                role: 'assistant',
                content: next[next.length - 1].content + delta,
              };
              return next;
            });
          } catch {
            // A malformed frame is not worth aborting the stream over.
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <Page title="Text" description="Chat completions through llama.cpp, streamed as they generate.">
      {models.loading ? (
        <Spinner className="size-4" />
      ) : ready.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No text models installed"
          description="Open Models in the top bar to install a GGUF model from the catalogue."
        />
      ) : (
        <Card className="flex h-[calc(100dvh-11rem)] flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border p-3">
            <Field label="Model" className="w-72">
              <Select
                value={model}
                onValueChange={setModel}
                options={ready.map((entry) => ({ value: entry.id, label: entry.name }))}
              />
            </Field>
            {messages.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-4"
                onClick={() => setMessages([])}
                disabled={streaming}
              >
                Clear
              </Button>
            ) : null}
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={MessageSquareText}
                  title="Start a conversation"
                  description="Responses stream token by token as the model produces them."
                />
              </div>
            ) : (
              messages.map((message, index) => (
                <div
                  key={index}
                  className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed',
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground',
                    )}
                  >
                    {message.content || (streaming ? <Spinner className="size-3" /> : null)}
                  </div>
                </div>
              ))
            )}
          </div>

          {error ? (
            <div className="px-4 pb-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}

          <div className="flex items-end gap-2 border-t border-border p-3">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, shift+enter breaks the line — the convention
                // every chat interface has trained people to expect.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask something…"
              rows={2}
              className="min-h-0 flex-1 resize-none"
            />
            {streaming ? (
              <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
                <Square />
                Stop
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={!input.trim()}>
                <SendHorizontal />
                Send
              </Button>
            )}
          </div>
        </Card>
      )}
    </Page>
  );
}
