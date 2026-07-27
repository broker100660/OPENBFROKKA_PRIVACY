import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

const GUEST_KEY = 'guest_id';

async function getOrCreateGuestId(): Promise<string> {
  let id = await AsyncStorage.getItem(GUEST_KEY);
  if (!id) {
    id = 'guest_' + Math.random().toString(36).substr(2, 9);
    await AsyncStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      // Always ensure guest ID exists
      await getOrCreateGuestId();

      const inTabsGroup = segments[0] === '(tabs)';

      // Client app always goes to tabs — no login required
      if (!inTabsGroup) {
        router.replace('/(tabs)');
      }

      setChecked(true);
    };

    checkAuth();
  }, []);

  if (!checked) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
