import { Routes } from '@angular/router';
import { LoginComponent } from './login/login';
import { RoomComponent } from './room/room';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  { path: 'room/:roomId', component: RoomComponent },
];
