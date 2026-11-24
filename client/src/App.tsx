import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { Layout, type NavTab } from './components/Layout';
import { AuthPage } from './pages/AuthPage';
import { TodayPage } from './pages/TodayPage';
import { CalendarPage } from './pages/CalendarPage';
import { JournalPage } from './pages/JournalPage';
import { PromptsPage } from './pages/PromptsPage';
import { SettingsPage } from './pages/SettingsPage';
import { InstallPwaPrompt } from './components/InstallPwaPrompt';
import type { Prompt } from './types';

function getInitialTab(): NavTab {
  if (
    window.location.pathname === '/settings' ||
    window.location.search.includes('gdrive=') ||
    window.location.search.includes('gdrive_error=')
  ) {
    return 'settings';
  }
  return 'today';
}

function AppShell() {
  const { status, loading } = useAuth();
  const [activeTab, setActiveTab] = useState<NavTab>(getInitialTab);
  const [pendingPrompt, setPendingPrompt] = useState<Prompt | null>(null);
  const [pendingTag, setPendingTag] = useState('');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  if (!status || !status.setupComplete || !status.authenticated) {
    return <AuthPage />;
  }

  const handleTagClick = (tag: string) => {
    setPendingTag(tag);
    setActiveTab('journal');
  };

  const handleSelectPrompt = (prompt: Prompt) => {
    setPendingPrompt(prompt);
    setActiveTab('today');
  };

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'today' && (
        <TodayPage
          pendingPrompt={pendingPrompt}
          onClearPendingPrompt={() => setPendingPrompt(null)}
          onTagClick={handleTagClick}
        />
      )}
      {activeTab === 'calendar' && <CalendarPage onTagClick={handleTagClick} />}
      {activeTab === 'journal' && (
        <JournalPage
          initialTag={pendingTag}
          onClearInitialTag={() => setPendingTag('')}
        />
      )}
      {activeTab === 'prompts' && <PromptsPage onSelectPrompt={handleSelectPrompt} />}
      {activeTab === 'settings' && <SettingsPage />}
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppShell />
        <InstallPwaPrompt />
      </AuthProvider>
    </ThemeProvider>
  );
}
