import { useEffect } from "react";
import { BellIcon, CloseIcon } from "./Icons";

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone?: "info" | "warn";
}

interface ToastItemProps {
  message: ToastMessage;
  onDismiss: (id: number) => void;
  onAction?: (message: ToastMessage) => void;
}

function ToastItem({ message, onDismiss, onAction }: ToastItemProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(message.id), 7000);
    return () => window.clearTimeout(timer);
  }, [message.id, onDismiss]);

  return (
    <div className={`toast toast--${message.tone ?? "info"}`}>
      <span className="toast__icon">
        <BellIcon />
      </span>
      <div className="toast__content">
        <strong>{message.title}</strong>
        {message.description ? <p>{message.description}</p> : null}
      </div>
      {onAction ? (
        <button type="button" className="toast__action" onClick={() => onAction(message)}>
          查看
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn toast__close"
        onClick={() => onDismiss(message.id)}
        aria-label="关闭提醒"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

interface ToastHostProps {
  messages: ToastMessage[];
  onDismiss: (id: number) => void;
  onAction?: (message: ToastMessage) => void;
}

export function ToastHost({ messages, onDismiss, onAction }: ToastHostProps) {
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {messages.map((message) => (
        <ToastItem key={message.id} message={message} onDismiss={onDismiss} onAction={onAction} />
      ))}
    </div>
  );
}
