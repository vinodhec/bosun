import {
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth } from './config.js';

const google = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, google);
}
export function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}
export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export function logout() {
  return signOut(auth);
}
