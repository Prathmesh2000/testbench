import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const cond = IBM_Plex_Sans_Condensed({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-cond', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = { title: 'Testbench', description: 'Test management for testers' };

// Applies the saved theme and density before first paint, so a light-theme user never sees a dark flash.
const prefsScript = `try{var b=document.body;if(localStorage.getItem('tb.theme')==='light')b.classList.add('light');if(localStorage.getItem('tb.density')==='comfy')b.classList.add('comfy')}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`${sans.variable} ${cond.variable} ${mono.variable}`}>
      <body className="tb">
        <script dangerouslySetInnerHTML={{ __html: prefsScript }} />
        {children}
      </body>
    </html>
  );
}
