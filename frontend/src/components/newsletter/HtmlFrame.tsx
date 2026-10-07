import React, { useCallback, useEffect, useRef, useState } from 'react';
import { handleFrameClick } from '../review/SendPreview';

interface HtmlFrameProps {
  html: string;
  title: string;
  className?: string;
  minHeight?: number;
}

/**
 * An email-style HTML document in a sandboxed frame (no scripts, no popups), sized to its
 * content. Links open in a new tab from this page (see SendPreview's handleFrameClick).
 */
export const HtmlFrame: React.FC<HtmlFrameProps> = ({ html, title, className, minHeight = 400 }) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const cleanup = useRef<(() => void) | null>(null);

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    const h = doc?.documentElement?.scrollHeight || doc?.body?.scrollHeight;
    if (h && h > 0) setHeight(Math.max(minHeight, h + 8));
  }, [minHeight]);

  const onLoad = useCallback(() => {
    cleanup.current?.();
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', handleFrameClick);
    // Images load after the document; measure again as they arrive
    const images = Array.from(doc.images || []);
    images.forEach((img) => img.addEventListener('load', measure));
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && doc.body) {
      observer = new ResizeObserver(() => measure());
      observer.observe(doc.body);
    }
    measure();
    cleanup.current = () => {
      doc.removeEventListener('click', handleFrameClick);
      images.forEach((img) => img.removeEventListener('load', measure));
      observer?.disconnect();
    };
  }, [measure]);

  useEffect(() => () => cleanup.current?.(), []);

  return (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      // No allow-scripts, no popups: the document can't run code or open windows.
      // allow-same-origin only lets this page size the frame and handle link clicks.
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={onLoad}
      style={{ width: '100%', border: 0, height, display: 'block' }}
    />
  );
};

export default HtmlFrame;
