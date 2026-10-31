import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import { Loading } from "./components/ui";
import { useSession } from "./context/use-session";
import { AppLayout } from "./layout/AppLayout";
import { CredentialsPage } from "./pages/CredentialsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { PipelineEditorPage } from "./pages/PipelineEditorPage";
import { PipelinePage } from "./pages/PipelinePage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ProposalPage } from "./pages/ProposalPage";
import { RunPage } from "./pages/RunPage";
import { RulesPage } from "./pages/RulesPage";
import { SettingsPage } from "./pages/SettingsPage";

/** Signed out: the login page for every path (the path is kept, so it opens after signing in). */
export function App() {
  const { session } = useSession();
  return (
    <>
      <ToastContainer position="bottom-right" newestOnTop />
      {session === undefined ? (
        <div className="page page-center">
          <Loading />
        </div>
      ) : session === null ? (
        <LoginPage />
      ) : (
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/inbox" replace />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="proposals/:proposalId" element={<ProposalPage />} />
            <Route path="pipelines" element={<PipelinesPage />} />
            <Route path="pipelines/new" element={<PipelineEditorPage />} />
            <Route path="pipelines/:pipelineId" element={<PipelinePage />} />
            <Route path="pipelines/:pipelineId/edit" element={<PipelineEditorPage />} />
            <Route path="runs/:runId" element={<RunPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="credentials" element={<CredentialsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  <p className="empty-title">Not found</p>
                  <Link to="/inbox">Back to the inbox</Link>
                </div>
              }
            />
          </Route>
        </Routes>
      )}
    </>
  );
}
