import * as React from 'react';
import { MessageSquareText, SendHorizontal, Square } from 'lucide-react';
import { api, useResource, waitForJob, type BundleInfo } from '@/lib/api';
import { Button, Card, EmptyState, ErrorNote, Field, Select, Spinner, Textarea } from '@/components/ui';
import { Page } from '@/components/layout';
import { cn } from '@/lib/utils';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Text generation (requirement 3), through the job queue.
 *
 * Completions are enqueued rather than streamed: a job is what puts them in the
 * queue view with every other generation, bounds them by `MAX_CONCURRENT_JOBS`
 * so a chat cannot load a second model alongside a running image job, and gives
 * Stop something real to cancel. The cost is token-by-token streaming — the
 * reply lands whole. `POST /v1/llm/chat/completions` still streams for API
 * clients that want it.
 */
export function TextPage() {
  const models = useResource<{ models: BundleInfo[] }>('/v1/models?kind=llm');
  const [model, setModel] = React.useState('');
  const [input, setInput] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const jobRef = React.useRef<string | null>(null);
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

    try {
      const job = await api.post<{ id: string }>('/v1/jobs/text', {
        model,
        messages: history,
      });
      jobRef.current = job.id;

      const finished = await waitForJob(job.id);
      if (finished.status === 'cancelled') {
        setMessages((current) => current.slice(0, -1));
        return;
      }
      if (finished.status === 'failed') {
        throw new Error(finished.error?.message ?? 'Text generation failed');
      }

      const reply = (finished.result?.text as string) ?? '';
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = { role: 'assistant', content: reply };
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages((current) => current.slice(0, -1));
    } finally {
      setStreaming(false);
      jobRef.current = null;
    }
  };

  return (
    <Page title="Text" description="Chat completions through llama.cpp, queued alongside every other generation.">
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
                  description="Each reply is queued as a job, so it appears in Jobs alongside every other generation."
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
              <Button
                variant="secondary"
                onClick={() => {
                  // Cancelling the job stops llama.cpp too, rather than just
                  // hanging up on a generation that keeps running.
                  if (jobRef.current) void api.post(`/v1/jobs/${jobRef.current}/cancel`);
                }}
              >
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
