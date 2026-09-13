'use client';

import { ReactNode } from 'react';
import { ClientProviders } from './ClientProviders';

interface PageWrapperProps {
    children: ReactNode;
};

/**
 * PageWrapper - A component to wrap page content with the Providers component
 * This helps avoid hydration issues in Next.js 15 with React 19 when using
 * wallet connection libraries like Wagmi
 */
export function PageWrapper({ children }: PageWrapperProps) {
    return <ClientProviders>{children}</ClientProviders>;
};

export default PageWrapper;