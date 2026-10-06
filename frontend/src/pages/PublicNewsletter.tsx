import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { newsletterService, NewsletterApiError } from '../services/newsletterService';
import HtmlFrame from '../components/newsletter/HtmlFrame';
import './PublicNewsletter.css';

/**
 * Public pages (no sign-in): the archive of sent newsletter editions, one edition as it was
 * sent, and a published "Read more" document.
 */

function usePageTitle(title: string | null) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function NotFound({ what }: { what: string }) {
  return (
    <div className="public-news-message" role="alert">
      <h2>{what} not found</h2>
      <p>It may not have been published yet. <Link to="/newsletter">See past editions</Link>.</p>
    </div>
  );
}

export const NewsletterArchive: React.FC = () => {
  const [editions, setEditions] = useState<Array<{ number: number; subject: string; sentAt: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageTitle('Black Rock Ranger News');

  useEffect(() => {
    newsletterService.listPublished()
      .then((r) => setEditions(r.editions))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="public-news">
      <header className="public-news-masthead">
        <h1>Black Rock Ranger News</h1>
        <p>All the Dust that Fits Under Your Hat</p>
      </header>
      {error && <div className="public-news-message" role="alert">{error}</div>}
      {!editions && !error && <div className="public-news-message">Loading…</div>}
      {editions && editions.length === 0 && <div className="public-news-message">No editions have been published here yet.</div>}
      {editions && editions.length > 0 && (
        <ol className="public-news-archive">
          {editions.map((e) => (
            <li key={e.number}>
              <Link to={`/newsletter/${e.number}`}>
                <span className="public-news-number">#{e.number}</span>
                <span className="public-news-subject">{e.subject.replace(/ - Ranger News #\d+$/, '')}</span>
                <span className="public-news-date">{formatDate(e.sentAt)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export const PublicEdition: React.FC = () => {
  const { number } = useParams<{ number: string }>();
  const [edition, setEdition] = useState<{ subject: string; sentAt: string; html: string } | null>(null);
  const [status, setStatus] = useState<'loading' | 'missing' | 'error' | 'ok'>('loading');
  usePageTitle(edition?.subject || null);

  useEffect(() => {
    setStatus('loading');
    newsletterService.getPublishedEdition(Number(number))
      .then((e) => {
        setEdition(e);
        setStatus('ok');
      })
      .catch((err) => setStatus(err instanceof NewsletterApiError && err.status === 404 ? 'missing' : 'error'));
  }, [number]);

  if (status === 'loading') return <div className="public-news-message">Loading…</div>;
  if (status === 'missing') return <NotFound what="Edition" />;
  if (status === 'error' || !edition) return <div className="public-news-message" role="alert">This edition couldn't be loaded.</div>;
  return (
    <div className="public-news public-news-reader">
      <nav className="public-news-crumbs"><Link to="/newsletter">← All editions</Link></nav>
      <HtmlFrame html={edition.html} title={edition.subject} className="public-news-frame" />
    </div>
  );
};

export const PublicDocument: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [doc, setDoc] = useState<{ subject: string; html: string } | null>(null);
  const [status, setStatus] = useState<'loading' | 'missing' | 'error' | 'ok'>('loading');
  usePageTitle(doc?.subject || null);

  useEffect(() => {
    setStatus('loading');
    newsletterService.getPublishedDocument(slug || '')
      .then((d) => {
        setDoc(d);
        setStatus('ok');
      })
      .catch((err) => setStatus(err instanceof NewsletterApiError && err.status === 404 ? 'missing' : 'error'));
  }, [slug]);

  if (status === 'loading') return <div className="public-news-message">Loading…</div>;
  if (status === 'missing') return <NotFound what="Page" />;
  if (status === 'error' || !doc) return <div className="public-news-message" role="alert">This page couldn't be loaded.</div>;
  return (
    <div className="public-news public-news-reader">
      <nav className="public-news-crumbs"><Link to="/newsletter">Black Rock Ranger News</Link></nav>
      <HtmlFrame html={doc.html} title={doc.subject} className="public-news-frame" />
    </div>
  );
};
