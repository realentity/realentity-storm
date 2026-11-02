import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import { Loading } from "./components/ui";
import { useSession } from "./context/use-session";
import { AppLayout } from "./layout/AppLayout";
import { BuilderPage } from "./pages/BuilderPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { InboxPage } from "./pages/InboxPage";
import { InsightPage } from "./pages/InsightPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { PipelineEditorPage } from "./pages/PipelineEditorPage";
import { PipelinePage } from "./pages/PipelinePage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ProposalPage } from "./pages/ProposalPage";
import { RecipePage, RecipesPage } from "./pages/RecipesPage";
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
            <Route path="builder" element={<BuilderPage />} />
            <Route path="builder/:chatId" element={<BuilderPage />} />
            <Route path="pipelines/:pipelineId" element={<PipelinePage />} />
            <Route path="pipelines/:pipelineId/edit" element={<PipelineEditorPage />} />
            <Route path="runs/:runId" element={<RunPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="insight" element={<InsightPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="recipes" element={<RecipesPage />} />
            <Route path="recipes/:site/:what" element={<RecipePage />} />
            <Route path="profile" element={<ProfilePage />} />
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
