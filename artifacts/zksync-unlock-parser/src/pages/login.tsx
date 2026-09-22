import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useCheckAuth } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Lock, Loader2 } from "lucide-react";

export default function Login() {
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: authData, isLoading: authLoading } = useCheckAuth();

  // A demo instance publishes its own password, so a visitor can get in with one click.
  // Auth itself is untouched — there is no bypass.
  const [demo, setDemo] = useState<{ demo: boolean; password?: string } | null>(null);
  useEffect(() => {
    fetch('/api/demo', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDemo(d))
      .catch(() => setDemo(null));
  }, []);

  useEffect(() => {
    if (!authLoading && authData?.authenticated) {
      setLocation("/");
    }
  }, [authData, authLoading, setLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isSubmitting) return;

    setIsSubmitting(true);
    setHasError(false);
    setErrorMessage("");

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });

      const data = await response.json();

      if (data.authenticated) {
        setLocation("/");
      } else {
        setHasError(true);
        setErrorMessage("Incorrect password");
        setTimeout(() => setHasError(false), 500);
      }
    } catch {
      setHasError(true);
      setErrorMessage("Network error. Please try again.");
      setTimeout(() => setHasError(false), 500);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <motion.div
        className="w-full max-w-sm p-8 bg-white border border-gray-200"
        animate={hasError ? { x: [-10, 10, -10, 10, 0] } : {}}
        transition={{ duration: 0.4 }}
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-gray-100 flex items-center justify-center mb-4 border border-gray-200">
            <Lock className="w-5 h-5 text-gray-600" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">ZKsync Verification</h1>
          <p className="text-sm text-gray-500 mt-1">Enter shared password to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
        {demo?.demo && (
          <div className="mb-4 border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong className="font-semibold">Demonstration instance.</strong> It runs on
            invented data and contacts nothing external.
            <button
              type="button"
              onClick={() => setPassword(demo.password ?? 'demo')}
              className="ml-1 underline underline-offset-2"
            >
              Use the demo password
            </button>
          </div>
        )}

            <Input
              type="password"
              placeholder="Dashboard Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={hasError ? "border-[#dc2626] focus-visible:ring-[#dc2626]" : ""}
              autoFocus
              aria-label="Dashboard password"
            />
            {errorMessage && (
              <p className="text-xs text-[#dc2626] mt-2 font-medium">{errorMessage}</p>
            )}
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting || !password}
          >
            {isSubmitting ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying...</>
            ) : (
              "Access Dashboard"
            )}
          </Button>
        </form>
      </motion.div>
    </div>
  );
}
