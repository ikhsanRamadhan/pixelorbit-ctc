"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
    const { theme = "system" } = useTheme()

    return (
        <Sonner
            theme={theme as ToasterProps["theme"]}
            className="toaster group"
            toastOptions={{
                classNames: {
                    toast: "group toast group-[.toaster]:bg-black/80 group-[.toaster]:text-white group-[.toaster]:border-cyan-500/50 group-[.toaster]:shadow-[0_0_15px_rgba(6,182,212,0.3)] group-[.toaster]:backdrop-blur-xl",
                    description: "group-[.toast]:text-cyan-200/70",
                    actionButton: "group-[.toast]:bg-cyan-500 group-[.toast]:text-white font-bold",
                    cancelButton: "group-[.toast]:bg-zinc-800 group-[.toast]:text-zinc-400",
                },
            }}
            style={{
                "--normal-bg": "rgba(0, 0, 0, 0.8)",
                "--normal-text": "#ecfeff",
                "--normal-border": "rgba(6, 182, 212, 0.5)",
                "--success-bg": "rgba(6, 182, 212, 0.2)",
                "--success-text": "#22d3ee",
                "--success-border": "rgba(6, 182, 212, 0.5)",
                "--error-bg": "rgba(153, 27, 27, 0.2)",
                "--error-text": "#f87171",
                "--error-border": "rgba(153, 27, 27, 0.5)",
            } as React.CSSProperties}
            {...props}
        />
    )
}

export { Toaster }