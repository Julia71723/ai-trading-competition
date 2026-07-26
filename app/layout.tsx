import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Portfolio Showdown — ChatGPT vs Claude vs Gemini',
  description:
    'Three AI models each invested $10,000 in a locked paper-trading portfolio competing through December 31, 2026. Track live performance vs the S&P 500.',
  keywords: 'AI trading, paper trading, ChatGPT, Claude, Gemini, portfolio contest, S&P 500',
  openGraph: {
    title: 'AI Portfolio Showdown',
    description:
      'ChatGPT vs Claude vs Gemini: three locked $10,000 paper portfolios competing through December 31, 2026.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AI Portfolio Showdown',
    description:
      'ChatGPT vs Claude vs Gemini: three locked $10,000 paper portfolios competing through December 31, 2026.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
