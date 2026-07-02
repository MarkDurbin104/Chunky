import React from 'react'

interface ErrorBoundaryProps {
  /** Element rendered in place of the children when an error is caught. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode
  /** Optional logger; defaults to console.error. */
  onError?: (error: Error, info: React.ErrorInfo) => void
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Small class-component error boundary. Wraps a subtree so that an
 * unhandled render error in (e.g.) BlockNote's side-menu doesn't unmount
 * the rest of the app — which would also clear the router state and
 * leave the user with a blank screen and a useless Back button.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, info)
    } else {
      console.error('[ErrorBoundary]', error, info)
    }
  }

  reset = () => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset)
      }
      return (
        <div className="error-boundary-fallback">
          <strong>Something went wrong rendering this section.</strong>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={this.reset}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
