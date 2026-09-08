import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Swords } from "lucide-react";
import { api } from "../api/client";

export default function Login() {
	const { login, setupPassword, pinLogin } = useAuth();
	const navigate = useNavigate();

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [pin, setPin] = useState(["", "", "", "", "", ""]);
	const [usePinMode, setUsePinMode] = useState(false);
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [setupRequired, setSetupRequired] = useState(false);
	const [setupAdminUsername, setSetupAdminUsername] = useState("");
	const [passwordSetupRequired, setPasswordSetupRequired] = useState(false);
	const [setupLoading, setSetupLoading] = useState(true);

	const pinRefs = useRef([]);

	useEffect(() => {
		const checkSetupStatus = async () => {
			try {
				const status = await api("/api/auth/setup-status");

				setSetupRequired(status.setup_required);
				setPasswordSetupRequired(status.password_setup_required === true);

				if (status.setup_required) {
					setSetupAdminUsername(status.admin_username || "");
				}
			} catch {
				// If setup status cannot be checked, fall back to normal login.
				setSetupRequired(false);
			} finally {
				setSetupLoading(false);
			}
		};

		checkSetupStatus();
	}, []);

	const handlePinChange = useCallback((index, value) => {
		if (value && !/^\d$/.test(value)) return;

		setPin((prev) => {
			const next = [...prev];
			next[index] = value;
			return next;
		});

		if (value && index < 5) {
			pinRefs.current[index + 1]?.focus();
		}
	}, []);

	const handlePinKeyDown = useCallback(
		(index, e) => {
			if (e.key === "Backspace" && !pin[index] && index > 0) {
				pinRefs.current[index - 1]?.focus();
			}
		},
		[pin],
	);

	const handlePinPaste = useCallback((e) => {
		e.preventDefault();
		const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
		if (!pasted) return;

		const digits = pasted.split("");
		setPin((prev) => {
			const next = [...prev];
			digits.forEach((d, i) => {
				next[i] = d;
			});
			return next;
		});

		const focusIndex = Math.min(digits.length, 5);
		pinRefs.current[focusIndex]?.focus();
	}, []);

	const handleSubmit = async (e) => {
		e.preventDefault();
		setError("");

		const loginUsername = setupRequired ? setupAdminUsername : username.trim();
		const isPasswordSetup = setupRequired && passwordSetupRequired;

		if (!isPasswordSetup && !loginUsername) {
			setError("Username is required");
			return;
		}

		if (isPasswordSetup) {
			if (!password) {
				setError("Password is required");
				return;
			}
			if (password.length < 6) {
				setError("Password must be at least 6 characters");
				return;
			}
			if (password !== confirmPassword) {
				setError("Passwords do not match");
				return;
			}
		} else if (usePinMode) {
			const pinStr = pin.join("");
			if (pinStr.length !== 6) {
				setError("Enter all 6 PIN digits");
				return;
			}
		} else if (!password) {
			setError("Password is required");
			return;
		}

		setSubmitting(true);
		try {
			if (isPasswordSetup) {
				await setupPassword(password, confirmPassword);
			} else if (usePinMode) {
				await pinLogin(username.trim(), pin.join(""));
			} else {
				await login(loginUsername, password);
			}
			navigate("/");
		} catch (err) {
			setError(err?.message || "Login failed. Check your credentials.");
		} finally {
			setSubmitting(false);
		}
	};

	if (setupLoading) {
		return (
			<div className='min-h-screen flex items-center justify-center px-4 py-10 bg-navy'>
				<div className='text-muted text-sm'>Loading...</div>
			</div>
		);
	}
	return (
		<div className='min-h-screen flex items-center justify-center px-4 py-10 bg-navy'>
			<form onSubmit={handleSubmit} className='game-panel w-full max-w-sm p-6'>
				{/* Logo */}
				<div className='flex items-center gap-2 mb-6'>
					<div className='w-8 h-8 rounded-md bg-accent flex items-center justify-center'>
						<Swords size={16} className='text-navy' />
					</div>
					<h1 className='text-cream text-lg font-semibold'>ChoreQuest</h1>
				</div>

				{/* First-time setup welcome */}
				{setupRequired && (
					<div className='mb-5'>
						<h2 className='text-cream text-lg font-semibold mb-1'>Welcome, {setupAdminUsername}!</h2>
						<p className='text-muted text-sm'>{passwordSetupRequired ? "Create your administrator password to begin first time setup." : "Please login to begin first time setup."}</p>
					</div>
				)}

				{/* Error */}
				{error && <div className='mb-4 p-2.5 rounded-md border border-crimson/30 bg-crimson/10 text-crimson text-sm'>{error}</div>}

				{/* Username */}
				{!setupRequired && (
					<div className='mb-3'>
						<label className='block text-cream text-sm font-medium mb-1'>Username</label>
						<input type='text' value={username} onChange={(e) => setUsername(e.target.value)} placeholder='Enter your username' autoComplete='username' className='field-input' />
					</div>
				)}

				{/* Mode toggle */}
				{!setupRequired && (
					<div className='flex items-center justify-between mb-3'>
						<span className='text-muted text-sm'>Login with:</span>
						<button
							type='button'
							onClick={() => {
								setUsePinMode(!usePinMode);
								setError("");
							}}
							className='flex items-center gap-2 text-sm'>
							<div className={`relative w-9 h-5 rounded-full transition-colors ${usePinMode ? "bg-accent/30 border border-accent/40" : "bg-navy border border-border"}`}>
								<div className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${usePinMode ? "left-4 bg-accent" : "left-0.5 bg-muted/60"}`} />
							</div>
							<span className={`font-medium ${usePinMode ? "text-accent" : "text-muted"}`}>{usePinMode ? "PIN" : "Password"}</span>
						</button>
					</div>
				)}

				{/* Password */}
				{!usePinMode && (
					<div className='mb-5'>
						<label className='block text-cream text-sm font-medium mb-1'>{passwordSetupRequired ? "Create Password" : "Password"}</label>
						<input type='password' value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordSetupRequired ? "Create your password" : "Enter your password"} autoComplete={passwordSetupRequired ? "new-password" : "current-password"} className='field-input' />
						{passwordSetupRequired && (
							<div className='mt-3'>
								<label className='block text-cream text-sm font-medium mb-1'>Confirm Password</label>
								<input type='password' value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder='Confirm your password' autoComplete='new-password' className='field-input' />
							</div>
						)}
					</div>
				)}

				{/* PIN entry */}
				{usePinMode && (
					<div className='mb-5'>
						<label className='block text-cream text-sm font-medium mb-1'>PIN Code</label>
						<div className='flex gap-2 justify-center' onPaste={handlePinPaste}>
							{pin.map((digit, i) => (
								<input key={i} ref={(el) => (pinRefs.current[i] = el)} type='text' inputMode='numeric' maxLength={1} value={digit} onChange={(e) => handlePinChange(i, e.target.value)} onKeyDown={(e) => handlePinKeyDown(i, e)} className='w-10 h-12 text-center text-lg bg-navy border border-border text-accent rounded-md font-bold focus:border-accent focus:outline-none transition-colors' />
							))}
						</div>
					</div>
				)}

				{/* Submit */}
				<button type='submit' disabled={submitting} className={`game-btn game-btn-blue w-full text-sm ${submitting ? "opacity-60 cursor-wait" : ""}`}>
					{submitting ? (passwordSetupRequired ? "Creating password..." : "Signing in...") : (passwordSetupRequired ? "Create Password" : "Sign in")}
				</button>
			</form>
		</div>
	);
}
