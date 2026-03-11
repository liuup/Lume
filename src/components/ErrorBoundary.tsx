import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("React ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-tauri-drag-region="true"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            width: "100vw",
            fontFamily: "system-ui, -apple-system, sans-serif",
            background: "#fafafa",
            color: "#18181b",
            padding: 40,
            cursor: "default",
          }}
        >
          <div style={{ paddingTop: 36 }} />
          <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <pre
            style={{
              fontSize: 12,
              color: "#dc2626",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              padding: 16,
              maxWidth: 600,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginBottom: 16,
            }}
          >
            {this.state.error?.message}
            {"\n\n"}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 24px",
              fontSize: 13,
              fontWeight: 500,
              background: "#18181b",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
