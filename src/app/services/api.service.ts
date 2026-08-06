import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** Stage 1 — user authentication */
export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

/** Stage 2/3 — room operations (snake_case to match FastAPI schema) */
export interface CreateRoomRequest {
  username: string;
  room_code: string;
  room_password: string;
}

export interface JoinRoomRequest {
  username: string;
  room_code: string;
  room_password: string;
}

export interface LeaveRoomRequest {
  username: string;
  room_code: string;
}

export interface ApiResponse {
  message: string;
  status: number;
  data?: {
    room_id?: number;
  };
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly BASE_URL = 'http://localhost:8000';

  constructor(private http: HttpClient) { }

  /** Register a new user account → POST /create-user */
  register(data: RegisterRequest): Observable<ApiResponse> {
    return this.http.post<ApiResponse>(`${this.BASE_URL}/create-user`, data);
  }

  /** Log in with existing credentials → POST /login-user */
  login(data: LoginRequest): Observable<ApiResponse> {
    return this.http.post<ApiResponse>(`${this.BASE_URL}/login-user`, data);
  }

  /** Create a new room → POST /create-room */
  createRoom(data: CreateRoomRequest): Observable<ApiResponse> {
    return this.http.post<ApiResponse>(`${this.BASE_URL}/create-room`, data);
  }

  /** Join an existing room → POST /join-room */
  joinRoom(data: JoinRoomRequest): Observable<ApiResponse> {
    return this.http.post<ApiResponse>(`${this.BASE_URL}/join-room`, data);
  }

  /** Leave a room → PUT /leave-room */
  leaveRoom(data: LeaveRoomRequest): Observable<ApiResponse> {
    return this.http.put<ApiResponse>(`${this.BASE_URL}/leave-room`, data);
  }
}
