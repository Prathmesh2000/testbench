import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Variable fonts, so every weight the CSS asks for is available. `--font-cond` is an alias of the UI face,
// defined in globals.css.
const sans = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = { title: 'Testbench', description: 'Test management for testers' };

// Applies the saved theme, density and nav width before first paint, so a light-theme user never sees a dark flash.
const prefsScript = `try{var b=document.body;if(localStorage.getItem('tb.theme')==='light')b.classList.add('light');if(localStorage.getItem('tb.density')==='comfy')b.classList.add('comfy');if(localStorage.getItem('tb.nav')==='mini')b.classList.add('navmini')}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`${sans.variable} ${mono.variable}`}>
      {/* The prefs script edits body's classes before hydration by design, so React must not flag that mismatch. */}
      <body className="tb" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: prefsScript }} />
        {children}
      </body>
    </html>
  );
}
