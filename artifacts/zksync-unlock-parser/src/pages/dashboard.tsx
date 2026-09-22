import React, { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useCheckAuth, useLogout, useGetSheetsStatus } from "@workspace/api-client-react";
import type { VerificationResult as VResult, CheckStatus, CheckDetail } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency } from "@/lib/utils";
import {
  LogOut, UploadCloud, FileSpreadsheet, Image as ImageIcon,
  CheckCircle2, AlertTriangle, XCircle, ArrowRight, Loader2, Download,
  RefreshCw, Check, X, ChevronDown
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import Papa from "papaparse";
import { motion, AnimatePresence } from "framer-motion";
import { jsPDF } from "jspdf";

interface ExtendedResult extends VResult {
  walletAddress?: string;
  notes?: string;
  statusLabel?: 'PASS' | 'FAIL' | 'FYI';
}

interface TextSummary {
  safeToSign: string;
  needsInvestigation: string;
  excluded: string;
}

interface VerificationResponseData {
  results: ExtendedResult[];
  summary: { total: number; passed: number; warnings: number; failed: number };
  textSummary?: TextSummary;
  sheetNames: string[];
  selectedSheet: string;
  tokenModelSyncedAt: string;
  financeWorkbookSyncedAt?: string;
  ocrTransactionCount?: number;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [isDraggingScreenshot, setIsDraggingScreenshot] = useState(false);

  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [isLoadingSheets, setIsLoadingSheets] = useState(false);

  const [results, setResults] = useState<VerificationResponseData | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  const { data: authData, isLoading: authLoading, isError: authError } = useCheckAuth();

  useEffect(() => {
    if (!authLoading && (authError || (authData && !authData.authenticated))) {
      setLocation("/login");
    }
  }, [authData, authLoading, authError, setLocation]);

  useEffect(() => {
    fetch('/api/ocr/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setHasApiKey(d.available))
      .catch(() => setHasApiKey(false));
  }, []);

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => setLocation("/login")
    }
  });

  const { data: sheetsStatus, isLoading: isSheetsLoading, refetch: refetchSheets } = useGetSheetsStatus({
    query: { refetchInterval: 60000, enabled: !!authData?.authenticated }
  });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setFileError(null);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) validateAndSetFile(droppedFile);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    if (e.target.files && e.target.files[0]) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const validateAndSetFile = async (f: File) => {
    if (f.name.endsWith('.xlsx') || f.name.endsWith('.xls')) {
      setFile(f);
      setResults(null);
      setVerifyError(null);
      setSheetNames([]);
      setSelectedSheet('');

      setIsLoadingSheets(true);
      try {
        const formData = new FormData();
        formData.append('file', f);
        const response = await fetch('/api/verify/sheets', {
          method: 'POST',
          body: formData,
          credentials: 'include',
        });
        if (response.ok) {
          const data = await response.json();
          setSheetNames(data.sheetNames || []);
          if (data.sheetNames?.length > 0) {
            setSelectedSheet(data.sheetNames[0]);
          }
        }
      } catch {
      } finally {
        setIsLoadingSheets(false);
      }
    } else {
      setFile(null);
      setFileError("Not an Excel file. Please upload .xlsx");
    }
  };

  const handleScreenshotDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingScreenshot(true);
  }, []);

  const handleScreenshotDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingScreenshot(false);
  }, []);

  const handleScreenshotDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingScreenshot(false);
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/')
    );
    if (files.length > 0) {
      setScreenshots((prev) => [...prev, ...files]);
    }
  }, []);

  const handleScreenshotInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files).filter(
        (f) => f.type.startsWith('image/')
      );
      setScreenshots((prev) => [...prev, ...files]);
    }
  };

  const handleVerify = async () => {
    if (!file) return;
    setFileError(null);
    setVerifyError(null);
    setIsVerifying(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (selectedSheet) {
        formData.append('sheetName', selectedSheet);
      }
      for (const screenshot of screenshots) {
        formData.append('screenshots', screenshot);
      }

      const response = await fetch('/api/verify', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Verification failed' }));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const data: VerificationResponseData = await response.json();
      setResults(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed. See details below.';
      setVerifyError(message);
    } finally {
      setIsVerifying(false);
    }
  };

  const exportCSV = () => {
    if (!results) return;

    const flatData = results.results.map(r => ({
      Status: (r as ExtendedResult).statusLabel || (r.status === 'GREEN' ? 'PASS' : r.status === 'YELLOW' ? 'FYI' : 'FAIL'),
      "Grant ID": r.grantId,
      Recipient: r.recipient,
      Amount: r.amount,
      Date: r.date,
      Notes: (r as ExtendedResult).notes || '',
      "Recipient Check": r.checks.recipientExists.status,
      "Recipient Detail": r.checks.recipientExists.detail,
      "Amount Check": r.checks.amountMatch.status,
      "Amount Detail": r.checks.amountMatch.detail,
      "Timing Check": r.checks.timingMatch.status,
      "Timing Detail": r.checks.timingMatch.detail,
      "Duplicate Check": r.checks.duplicateCheck?.status || 'N/A',
      "Duplicate Detail": r.checks.duplicateCheck?.detail || '',
      "Cumulative Check": r.checks.cumulativeCheck?.status || 'N/A',
      "Cumulative Detail": r.checks.cumulativeCheck?.detail || '',
      "Screenshot Check": r.checks.screenshotMatch?.status || 'N/A',
      "Screenshot Detail": r.checks.screenshotMatch?.detail || '',
    }));

    const csv = Papa.unparse(flatData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `zksync-verification-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    if (!results) return;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 15;
    const usableWidth = pageWidth - margin * 2;
    let y = 20;

    const checkPageBreak = (needed: number) => {
      if (y + needed > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage();
        y = 20;
      }
    };

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('ZKsync Token Verification Report', margin, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    doc.text(`Date: ${dateStr}  |  Sheet: ${results.selectedSheet}`, margin, y);
    y += 6;
    doc.text(`${results.summary.passed} passed  ·  ${results.summary.warnings} FYI  ·  ${results.summary.failed} failed  ·  ${results.summary.total} total`, margin, y);
    y += 10;

    doc.setDrawColor(200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;

    if (results.textSummary) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text('Summary', margin, y);
      y += 7;

      doc.setFontSize(9);

      doc.setFont('helvetica', 'bold');
      doc.text('Safe to sign:', margin, y);
      doc.setFont('helvetica', 'normal');
      const safeText = results.textSummary.safeToSign.replace('Safe to sign: ', '');
      const safeLines = doc.splitTextToSize(safeText, usableWidth - 25);
      doc.text(safeLines, margin + 25, y);
      y += Math.max(safeLines.length * 4, 5) + 3;

      if (results.textSummary.needsInvestigation !== 'Needs investigation: none') {
        checkPageBreak(10);
        doc.setFont('helvetica', 'bold');
        doc.text('Needs investigation:', margin, y);
        doc.setFont('helvetica', 'normal');
        const invText = results.textSummary.needsInvestigation.replace('Needs investigation: ', '');
        const invLines = doc.splitTextToSize(invText, usableWidth - 35);
        doc.text(invLines, margin + 35, y);
        y += Math.max(invLines.length * 4, 5) + 3;
      }

      if (results.textSummary.excluded !== 'Excluded: none') {
        checkPageBreak(10);
        doc.setFont('helvetica', 'bold');
        doc.text('Excluded:', margin, y);
        doc.setFont('helvetica', 'normal');
        const exText = results.textSummary.excluded.replace(/^Excluded.*?: /, '');
        const exLines = doc.splitTextToSize(exText, usableWidth - 20);
        doc.text(exLines, margin + 20, y);
        y += Math.max(exLines.length * 4, 5) + 3;
      }

      y += 5;
      doc.setDrawColor(200);
      doc.line(margin, y, pageWidth - margin, y);
      y += 8;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Verification Results', margin, y);
    y += 7;

    const colX = [margin, margin + 14, margin + 34, margin + 80, margin + 115, margin + 140];
    const headers = ['Status', 'Grant ID', 'Recipient', 'Amount', 'Date', 'Notes'];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    headers.forEach((h, i) => doc.text(h, colX[i], y));
    y += 2;
    doc.setDrawColor(180);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    const sorted = [...results.results].sort((a, b) => {
      const pri: Record<string, number> = { RED: 0, GREEN: 1, YELLOW: 2 };
      return (pri[a.status] ?? 2) - (pri[b.status] ?? 2);
    });

    for (const r of sorted) {
      checkPageBreak(6);
      const label = (r as ExtendedResult).statusLabel || (r.status === 'GREEN' ? 'PASS' : r.status === 'YELLOW' ? 'FYI' : 'FAIL');
      const isFail = label === 'FAIL';
      doc.setFont('helvetica', isFail ? 'bold' : 'normal');
      doc.text(label, colX[0], y);
      doc.text(r.grantId.substring(0, 12), colX[1], y);
      doc.text(r.recipient.substring(0, 28), colX[2], y);
      doc.text(formatCurrency(r.amount), colX[3], y);
      doc.text(r.date || '', colX[4], y);
      doc.setFont('helvetica', 'normal');
      doc.text(((r as ExtendedResult).notes || '').substring(0, 20), colX[5], y);
      y += 5;
    }

    y += 5;
    checkPageBreak(10);
    doc.setDrawColor(200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 5;
    doc.setFontSize(7);
    doc.setTextColor(140);
    doc.text(`Generated by ZKsync Token Verification Dashboard  |  ${new Date().toISOString()}`, margin, y);

    doc.save(`zksync-verification-${new Date().toISOString().split('T')[0]}.pdf`);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div className="w-full max-w-[1200px] px-6 py-8 flex flex-col flex-1">

        <header className="flex items-center justify-between border-b border-border pb-6 mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">ZKsync Token Verification</h1>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {isSheetsLoading ? (
                <span className="flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Checking sync...</span>
              ) : sheetsStatus ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-2 h-2 rounded-full", sheetsStatus.tokenModelSynced ? "bg-[#16a34a]" : "bg-[#dc2626]")} />
                    <span>Token Model: {sheetsStatus.tokenModelSyncedAt ? `synced ${formatDistanceToNow(new Date(sheetsStatus.tokenModelSyncedAt))} ago` : 'not synced'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-2 h-2 rounded-full", sheetsStatus.financeWorkbookSynced ? "bg-[#16a34a]" : "bg-[#dc2626]")} />
                    <span>Finance WB: {sheetsStatus.financeWorkbookSyncedAt ? `synced ${formatDistanceToNow(new Date(sheetsStatus.financeWorkbookSyncedAt))} ago` : 'not synced'}</span>
                  </div>
                  <button onClick={() => refetchSheets()} className="hover:text-foreground transition-colors p-1" aria-label="Refresh sync status">
                    <RefreshCw className="w-3 h-3" />
                  </button>
                </>
              ) : (
                <span className="text-[#dc2626]">Can't reach Google Sheets</span>
              )}
            </div>

            <Button variant="ghost" size="sm" onClick={() => logoutMutation.mutate()} className="text-muted-foreground">
              <LogOut className="w-4 h-4 mr-2" /> Logout
            </Button>
          </div>
        </header>

        {!results && (
          <div className="w-full mb-12">
            <div className="grid grid-cols-2 gap-6">
              <motion.div
                className={cn(
                  "relative flex flex-col items-center justify-center p-10 border-2 border-dashed transition-colors cursor-pointer",
                  isDragging ? "border-gray-900 bg-gray-50" : "border-gray-300 bg-white",
                  fileError ? "border-[#dc2626] bg-red-50/30" : "",
                  file ? "border-[#16a34a] bg-green-50/20" : ""
                )}
                animate={fileError ? { x: [-5, 5, -5, 5, 0] } : {}}
                transition={{ duration: 0.3 }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => !file && fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileInput}
                  accept=".xlsx,.xls"
                />

                {file ? (
                  <div className="flex flex-col items-center text-center space-y-3">
                    <div className="w-12 h-12 bg-green-50 flex items-center justify-center rounded-full text-[#16a34a]">
                      <FileSpreadsheet className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{file.name}</p>
                      {isLoadingSheets ? (
                        <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Reading sheets...
                        </p>
                      ) : sheetNames.length > 1 ? (
                        <div className="mt-2 relative">
                          <select
                            value={selectedSheet}
                            onChange={(e) => setSelectedSheet(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="appearance-none bg-white border border-gray-200 text-xs px-3 py-1.5 pr-7 cursor-pointer hover:border-gray-400 transition-colors focus:outline-none focus:ring-1 focus:ring-gray-300"
                          >
                            {sheetNames.map((name) => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                          <ChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                        </div>
                      ) : (
                        <p className="text-xs text-[#16a34a] mt-1 flex items-center justify-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Ready to verify
                        </p>
                      )}
                    </div>
                    <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); setSheetNames([]); setSelectedSheet(''); }} className="mt-2 text-xs h-7">
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-center space-y-3">
                    <UploadCloud className="w-8 h-8 text-gray-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-700">Drop your custody export (.xlsx) here</p>
                      <p className="text-xs text-gray-400 mt-1">or click to browse — accepts .xlsx</p>
                      {fileError && <p className="text-xs text-[#dc2626] mt-2 font-medium">{fileError}</p>}
                    </div>
                  </div>
                )}
              </motion.div>

              {hasApiKey === false ? (
                <div className="relative flex flex-col items-center justify-center p-10 border-2 border-dashed border-gray-200 bg-gray-50/50">
                  <div className="flex flex-col items-center text-center space-y-3">
                    <ImageIcon className="w-8 h-8 text-gray-300" />
                    <div>
                      <p className="text-sm font-medium text-gray-500">Screenshot verification unavailable</p>
                      <p className="text-xs text-gray-400 mt-1">Add OPENROUTER_API_KEY to Secrets to enable screenshot verification</p>
                    </div>
                  </div>
                </div>
              ) : (
                <motion.div
                  className={cn(
                    "relative flex flex-col items-center justify-center p-10 border-2 border-dashed transition-colors cursor-pointer",
                    isDraggingScreenshot ? "border-gray-900 bg-gray-50" : "border-gray-300 bg-white",
                    screenshots.length > 0 ? "border-blue-400 bg-blue-50/20" : ""
                  )}
                  onDragOver={handleScreenshotDragOver}
                  onDragLeave={handleScreenshotDragLeave}
                  onDrop={handleScreenshotDrop}
                  onClick={() => screenshotInputRef.current?.click()}
                >
                  <input
                    type="file"
                    className="hidden"
                    ref={screenshotInputRef}
                    onChange={handleScreenshotInput}
                    accept=".jpg,.jpeg,.png"
                    multiple
                  />

                  {screenshots.length > 0 ? (
                    <div className="flex flex-col items-center text-center space-y-3">
                      <div className="w-12 h-12 bg-blue-50 flex items-center justify-center rounded-full text-blue-500">
                        <ImageIcon className="w-6 h-6" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''} ready</p>
                        <p className="text-xs text-blue-500 mt-1">Will be OCR-processed during verification</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); screenshotInputRef.current?.click(); }} className="text-xs h-7">
                          Add more
                        </Button>
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setScreenshots([]); }} className="text-xs h-7">
                          Clear
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center text-center space-y-3">
                      <ImageIcon className="w-8 h-8 text-gray-400" />
                      <div>
                        <p className="text-sm font-medium text-gray-700">Drop custody queue screenshots here</p>
                        <p className="text-xs text-gray-400 mt-1">optional — .jpg, .png (multiple allowed)</p>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3">
              {verifyError && (
                <p className="text-sm text-[#dc2626] font-medium">{verifyError}</p>
              )}
              {file ? (
                <Button
                  size="lg"
                  className="w-full max-w-sm"
                  onClick={handleVerify}
                  disabled={isVerifying}
                >
                  {isVerifying ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {screenshots.length > 0 ? 'Verifying + OCR processing...' : 'Verifying transactions...'}</>
                  ) : (
                    screenshots.length > 0 ? `Verify Now (+ ${screenshots.length} screenshot${screenshots.length > 1 ? 's' : ''})` : "Verify Now"
                  )}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Upload an Excel file to start</p>
              )}
            </div>
          </div>
        )}

        {results && (
          <div className="flex flex-col flex-1">

            <div className="flex items-center justify-between bg-gray-100 px-6 py-4 mb-6">
              <div className="flex items-center gap-8">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[#16a34a]">{results.summary.passed}</span>
                  <span className="text-sm text-muted-foreground">passed</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[#6b7280]">{results.summary.warnings}</span>
                  <span className="text-sm text-muted-foreground">FYI</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[#dc2626]">{results.summary.failed}</span>
                  <span className="text-sm text-muted-foreground">failed</span>
                </div>
                {results.ocrTransactionCount !== undefined && results.ocrTransactionCount > 0 && (
                  <div className="flex items-center gap-2 border-l border-gray-300 pl-6">
                    <ImageIcon className="w-4 h-4 text-blue-500" />
                    <span className="text-sm text-muted-foreground">{results.ocrTransactionCount} OCR transactions matched</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Sheet: {results.selectedSheet}</span>
                <Button variant="outline" size="sm" onClick={() => { setResults(null); setFile(null); setScreenshots([]); setSheetNames([]); setSelectedSheet(''); }}>
                  New Verification
                </Button>
                <Button size="sm" onClick={exportCSV}>
                  <Download className="w-4 h-4 mr-2" /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={exportPDF}>
                  <Download className="w-4 h-4 mr-2" /> PDF
                </Button>
              </div>
            </div>

            {results.textSummary && <TextSummaryBanner summary={results.textSummary} />}

            <ResultsTable data={results.results} />

            <div className="mt-6 pb-6 flex items-center gap-6 text-xs text-muted-foreground">
              <span>Token Model: synced {results.tokenModelSyncedAt ? formatDistanceToNow(new Date(results.tokenModelSyncedAt)) + ' ago' : 'unknown'}</span>
              {results.financeWorkbookSyncedAt && (
                <span>Finance Workbook: synced {formatDistanceToNow(new Date(results.financeWorkbookSyncedAt))} ago</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TextSummaryBanner({ summary }: { summary: TextSummary }) {
  const [showExcluded, setShowExcluded] = useState(false);

  const safeNames = summary.safeToSign.replace('Safe to sign: ', '');
  const hasInvestigation = summary.needsInvestigation !== 'Needs investigation: none';
  const investigationText = summary.needsInvestigation.replace('Needs investigation: ', '');
  const hasExcluded = summary.excluded !== 'Excluded: none';
  const excludedText = summary.excluded.replace(/^Excluded.*?: /, '');

  return (
    <div className="mb-6 bg-gray-50 border border-gray-200">
      <div className="border-l-4 border-[#16a34a] px-5 py-3">
        <div className="flex items-start gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0 pt-0.5">Safe to sign</span>
          <p className="text-sm text-gray-800">{safeNames}</p>
        </div>
      </div>

      {hasInvestigation && (
        <div className="border-l-4 border-[#dc2626] px-5 py-3 border-t border-t-gray-200">
          <div className="flex items-start gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0 pt-0.5">Needs investigation</span>
            <p className="text-sm text-gray-800">{investigationText}</p>
          </div>
        </div>
      )}

      {hasExcluded && (
        <div className="border-l-4 border-[#d1d5db] px-5 py-3 border-t border-t-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Excluded</span>
            <button
              onClick={() => setShowExcluded(!showExcluded)}
              className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
            >
              {showExcluded ? 'Hide' : 'Show excluded'}
            </button>
          </div>
          {showExcluded && (
            <p className="text-sm text-gray-500 mt-1.5 ml-0">{excludedText}</p>
          )}
        </div>
      )}
    </div>
  );
}

type SortField = 'status' | 'grantId' | 'recipient' | 'amount' | 'date';
type SortOrder = 'asc' | 'desc';

const statusPriority: Record<string, number> = { RED: 0, GREEN: 1, YELLOW: 2 };

function worstStatus(rows: ExtendedResult[]): CheckStatus {
  if (rows.some((r) => r.status === 'RED')) return 'RED';
  if (rows.some((r) => r.status === 'GREEN')) return 'GREEN';
  return 'YELLOW';
}

function worstLabel(rows: ExtendedResult[]): 'PASS' | 'FAIL' | 'FYI' {
  if (rows.some((r) => (r.statusLabel || r.status) === 'FAIL' || r.status === 'RED')) return 'FAIL';
  if (rows.some((r) => r.status === 'GREEN')) return 'PASS';
  return 'FYI';
}

interface RecipientGroup {
  recipient: string;
  rows: ExtendedResult[];
  totalAmount: number;
  status: CheckStatus;
  statusLabel: 'PASS' | 'FAIL' | 'FYI';
  dates: string[];
  worstNote: string;
  isSingle: boolean;
}

function groupByRecipient(data: ExtendedResult[]): RecipientGroup[] {
  const groups = new Map<string, ExtendedResult[]>();
  for (const row of data) {
    const key = row.recipient.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.values()).map((rows) => {
    const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
    const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))];
    const noteRows = rows.filter((r) => r.notes);
    const worstNote = noteRows.length > 0 ? noteRows[0].notes! : '';

    return {
      recipient: rows[0].recipient,
      rows,
      totalAmount,
      status: worstStatus(rows),
      statusLabel: worstLabel(rows),
      dates,
      worstNote,
      isSingle: rows.length === 1,
    };
  });
}

function ResultsTable({ data }: { data: ExtendedResult[] }) {
  const [sortField, setSortField] = useState<SortField>('status');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedChildId, setExpandedChildId] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const groups = groupByRecipient(data);

  const sortedGroups = [...groups].sort((a, b) => {
    let comparison = 0;
    if (sortField === 'status') {
      comparison = (statusPriority[a.status] ?? 2) - (statusPriority[b.status] ?? 2);
    } else if (sortField === 'grantId') {
      comparison = a.rows[0].grantId.localeCompare(b.rows[0].grantId);
    } else if (sortField === 'recipient') {
      comparison = a.recipient.localeCompare(b.recipient);
    } else if (sortField === 'amount') {
      comparison = a.totalAmount - b.totalAmount;
    } else if (sortField === 'date') {
      comparison = new Date(a.dates[0] || '').getTime() - new Date(b.dates[0] || '').getTime();
    }
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return '';
    return sortOrder === 'asc' ? ' ↑' : ' ↓';
  };

  return (
    <div className="w-full border border-gray-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left" role="table">
          <thead className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900" onClick={() => handleSort('status')}>Status{sortIndicator('status')}</th>
              <th scope="col" className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900" onClick={() => handleSort('grantId')}>Grant ID{sortIndicator('grantId')}</th>
              <th scope="col" className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900" onClick={() => handleSort('recipient')}>Recipient{sortIndicator('recipient')}</th>
              <th scope="col" className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900 text-right" onClick={() => handleSort('amount')}>Amount{sortIndicator('amount')}</th>
              <th scope="col" className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900" onClick={() => handleSort('date')}>Date{sortIndicator('date')}</th>
              <th scope="col" className="px-4 py-3 font-medium">Notes</th>
              <th scope="col" className="px-4 py-3 w-10"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sortedGroups.map((group) => {
              if (group.isSingle) {
                const row = group.rows[0];
                const rowKey = `single-${row.grantId}`;
                const isExpanded = expandedChildId === rowKey;
                return (
                  <React.Fragment key={rowKey}>
                    <SingleRow
                      row={row}
                      rowKey={rowKey}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedChildId(isExpanded ? null : rowKey)}
                    />
                  </React.Fragment>
                );
              }

              const groupKey = `group-${group.recipient}`;
              const isGroupExpanded = expandedId === groupKey;
              const dateRange = group.dates.length === 1 ? group.dates[0] : group.dates.length > 1 ? `${group.dates[0]} — ${group.dates[group.dates.length - 1]}` : '';

              return (
                <React.Fragment key={groupKey}>
                  <tr
                    className={cn(
                      "hover:bg-gray-50 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-300 bg-gray-50/40",
                      isGroupExpanded ? "bg-gray-100/60" : ""
                    )}
                    onClick={() => { setExpandedId(isGroupExpanded ? null : groupKey); if (isGroupExpanded) setExpandedChildId(null); }}
                    tabIndex={0}
                    role="row"
                    aria-expanded={isGroupExpanded}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedId(isGroupExpanded ? null : groupKey);
                        if (isGroupExpanded) setExpandedChildId(null);
                      }
                    }}
                  >
                    <td className="px-4 py-3 w-[100px]">
                      <StatusPill status={group.status} statusLabel={group.statusLabel} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-400">
                      {group.rows.length} streams
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {group.recipient}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold">{formatCurrency(group.totalAmount)}<span className="text-gray-400 ml-1 font-normal">total</span></td>
                    <td className="px-4 py-3 text-gray-500">{dateRange}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-[120px]">
                      {group.worstNote && (
                        <span className="inline-flex px-2 py-0.5 text-[10px] font-medium bg-[#f3f4f6] text-[#6b7280] border border-[#d1d5db]">
                          {group.worstNote}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronDown className={cn("w-4 h-4 text-gray-400 transition-transform inline-block", isGroupExpanded ? "rotate-180" : "")} />
                    </td>
                  </tr>

                  <AnimatePresence>
                    {isGroupExpanded && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: "easeInOut" }}
                            className="overflow-hidden"
                          >
                            <table className="w-full text-sm text-left">
                              <tbody className="divide-y divide-gray-100 bg-white">
                                {group.rows.map((row, idx) => {
                                  const childKey = `child-${row.grantId}-${idx}`;
                                  const isChildExpanded = expandedChildId === childKey;
                                  return (
                                    <React.Fragment key={childKey}>
                                      <SingleRow
                                        row={row}
                                        rowKey={childKey}
                                        isExpanded={isChildExpanded}
                                        onToggle={() => setExpandedChildId(isChildExpanded ? null : childKey)}
                                        isNested
                                      />
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </motion.div>
                        </td>
                      </tr>
                    )}
                  </AnimatePresence>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SingleRow({ row, rowKey, isExpanded, onToggle, isNested = false }: {
  row: ExtendedResult;
  rowKey: string;
  isExpanded: boolean;
  onToggle: () => void;
  isNested?: boolean;
}) {
  return (
    <>
      <tr
        className={cn(
          "hover:bg-gray-50 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-300",
          isExpanded ? "bg-gray-50" : "",
          isNested ? "border-l-2 border-l-gray-200" : ""
        )}
        onClick={onToggle}
        tabIndex={0}
        role="row"
        aria-expanded={isExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td className={cn("px-4 py-3 w-[100px]", isNested ? "pl-8" : "")}>
          <StatusPill status={row.status} statusLabel={(row as ExtendedResult).statusLabel} />
        </td>
        <td className="px-4 py-3 font-mono text-xs font-medium">{row.grantId}</td>
        <td className="px-4 py-3 truncate max-w-[200px]">{row.recipient}</td>
        <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(row.amount)}</td>
        <td className="px-4 py-3 text-gray-500">{row.date}</td>
        <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-[120px]">
          {row.notes && (
            <span className={cn(
              "inline-flex px-2 py-0.5 text-[10px] font-medium",
              row.notes.toLowerCase().includes('pause') || row.notes.toLowerCase().includes('skip') || row.notes.toLowerCase().includes('no wallet')
                ? "bg-[#f3f4f6] text-[#6b7280] border border-[#d1d5db]"
                : "bg-gray-100 text-gray-600"
            )}>
              {row.notes}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <ArrowRight className={cn("w-4 h-4 text-gray-400 transition-transform inline-block", isExpanded ? "rotate-90" : "")} />
        </td>
      </tr>

      <AnimatePresence>
        {isExpanded && (
          <tr className="bg-gray-50/80">
            <td colSpan={7} className="p-0">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="p-6 grid grid-cols-3 gap-4">
                  <CheckDetailCard title="Recipient & Grant" check={row.checks.recipientExists} label="Token Model" />
                  <CheckDetailCard title="Amount Match" check={row.checks.amountMatch} label="Token Model" isCurrency />
                  <CheckDetailCard title="Timing Match" check={row.checks.timingMatch} label="Token Model" isDate />
                  {row.checks.duplicateCheck && (
                    <CheckDetailCard title="Duplicate Check" check={row.checks.duplicateCheck} label="Finance Workbook" />
                  )}
                  {row.checks.cumulativeCheck && (
                    <CheckDetailCard title="Cumulative Limits" check={row.checks.cumulativeCheck} label="Vesting Schedule" />
                  )}
                  {row.checks.screenshotMatch ? (
                    <CheckDetailCard title="Screenshot Match" check={row.checks.screenshotMatch} label="OCR" />
                  ) : (
                    <div className="bg-white p-4 border border-gray-200 opacity-50">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-semibold text-gray-700">Screenshot Match</h4>
                        <span className="text-[10px] uppercase font-bold tracking-wider text-gray-400 bg-gray-100 px-2 py-0.5">NO DATA</span>
                      </div>
                      <p className="text-xs text-gray-400">No screenshot uploaded for comparison</p>
                    </div>
                  )}
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

function StatusPill({ status, statusLabel }: { status: CheckStatus; statusLabel?: 'PASS' | 'FAIL' | 'FYI' }) {
  const label = statusLabel || (status === 'GREEN' ? 'PASS' : status === 'YELLOW' ? 'FYI' : 'FAIL');
  if (label === 'PASS') return <span className="inline-flex items-center justify-center px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#16a34a] bg-[#16a34a]/10 border border-[#16a34a]/20">PASS</span>;
  if (label === 'FYI') return <span className="inline-flex items-center justify-center px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#6b7280] bg-[#f3f4f6] border border-[#d1d5db]">FYI</span>;
  return <span className="inline-flex items-center justify-center px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#dc2626] bg-[#dc2626]/10 border border-[#dc2626]/20">FAIL</span>;
}

function CheckDetailCard({
  title,
  check,
  label,
  isCurrency = false,
  isDate = false
}: {
  title: string;
  check: CheckDetail;
  label: string;
  isCurrency?: boolean;
  isDate?: boolean;
}) {
  const formatVal = (val?: number | string) => {
    if (val === undefined || val === null) return 'N/A';
    if (isCurrency && typeof val === 'number') return formatCurrency(val);
    return String(val);
  };

  const hasMismatch = check.status !== 'GREEN';

  return (
    <div className={cn("bg-white p-4 border", check.status === 'RED' ? "border-red-200" : "border-gray-200")}>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold text-gray-700">{title}</h4>
        {check.status === 'GREEN' ? <Check className="w-4 h-4 text-[#16a34a]" /> :
         check.status === 'YELLOW' ? <AlertTriangle className="w-4 h-4 text-[#6b7280]" /> :
         <X className="w-4 h-4 text-[#dc2626]" />}
      </div>

      <p className="text-xs text-gray-500 mb-4 leading-relaxed">{check.detail}</p>

      {(check.expected !== undefined || check.expectedDate) && (
        <div className="space-y-1.5 text-xs font-mono">
          <div className="flex justify-between items-center py-1 border-b border-gray-100">
            <span className="text-gray-400 font-sans text-[11px] uppercase tracking-wider">{label}:</span>
            <span className={cn("font-medium", hasMismatch ? "text-[#16a34a]" : "text-gray-900")}>
              {formatVal(isDate ? check.expectedDate : check.expected)}
            </span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-gray-400 font-sans text-[11px] uppercase tracking-wider">Excel Upload:</span>
            <span className={cn("font-medium", hasMismatch ? "text-[#dc2626]" : "text-gray-900")}>
              {formatVal(isDate ? check.actualDate : check.actual)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
