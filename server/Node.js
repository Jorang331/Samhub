const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const teacherDirectory = require('./data/teacher-directory');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? null : 'change-this-secret-in-development-only');
if (isProduction && (!JWT_SECRET || JWT_SECRET.length < 32)) {
	throw new Error('Production requires JWT_SECRET with at least 32 characters.');
}
const allowedOrigins = (process.env.CORS_ORIGIN || 'null,http://localhost:3000,http://127.0.0.1:3000')
	.split(',').map(origin => origin.trim()).filter(Boolean);
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const CATEGORY_ICONS = new Set(['folder', 'users', 'book', 'star', 'bullhorn', 'calendar', 'music', 'camera']);
const CATEGORY_COLORS = new Set(['slate', 'blue', 'emerald', 'indigo', 'orange', 'rose', 'amber', 'cyan']);
const MAX_POST_ATTACHMENTS = 5;
const MAX_POST_ATTACHMENT_DATA_LENGTH = 28 * 1024 * 1024;

for (const directory of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(directory, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
	fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], applications: [], posts: [], customSchedules: [], customCategories: [], inquiries: [] }, null, 2));
}

const upload = multer({
	dest: UPLOAD_DIR,
	limits: { fileSize: 5 * 1024 * 1024 },
	fileFilter: (request, file, callback) => callback(null, file.mimetype.startsWith('image/'))
});

app.use(cors({
	origin: (origin, callback) => {
		if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
		return callback(new Error('Origin is not allowed.'));
	}
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');
app.use((request, response, next) => {
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('X-Frame-Options', 'DENY');
	response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (request.secure || request.headers['x-forwarded-proto'] === 'https') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	next();
});
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('/health', (request, response) => response.json({ status: 'ok' }));
app.get('/', (request, response) => response.sendFile(path.join(__dirname, '..', 'samhub.html')));

const readDb = () => {
	const database = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
	if (!Array.isArray(database.customSchedules)) database.customSchedules = [];
	if (!Array.isArray(database.notices)) database.notices = [];
	if (!Array.isArray(database.customCategories)) database.customCategories = [];
	if (!Array.isArray(database.inquiries)) database.inquiries = [];
	return database;
};
const writeDb = database => fs.writeFileSync(DB_FILE, JSON.stringify(database, null, 2));

const transporter = nodemailer.createTransport({
	host: process.env.SMTP_HOST || 'localhost',
	port: Number(process.env.SMTP_PORT) || 587,
	secure: process.env.SMTP_SECURE === 'true',
	auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
});

const sendEmail = async (to, subject, text) => {
	if (!process.env.SMTP_HOST) return console.log(`[EMAIL] To: ${to}, Subject: ${subject}`);
	try {
		await transporter.sendMail({ from: process.env.MAIL_FROM || 'noreply@samcheok-hub.com', to, subject, text });
		return true;
	} catch (error) {
		console.error('Email error:', error.message);
		return false;
	}
};

const requireAuth = (request, response, next) => {
	const token = request.headers.authorization?.split(' ')[1];
	if (!token) return response.status(401).json({ message: '로그인이 필요합니다.' });
	try {
		request.auth = jwt.verify(token, JWT_SECRET);
		next();
	} catch (error) {
		response.status(401).json({ message: '유효하지 않은 토큰입니다.' });
	}
};

const requireAdmin = (request, response, next) => {
	if (request.auth.role !== 'admin') return response.status(403).json({ message: '관리자 권한이 필요합니다.' });
	next();
};

app.get('/api/teachers', requireAuth, (request, response) => {
	response.json(teacherDirectory);
});

app.post('/api/auth/signup', upload.single('studentCard'), async (request, response) => {
	const { name, studentNumber, email, username, password, grade, classNumber } = request.body;
	if (!name || !studentNumber || !email || !username || !password || !grade || !classNumber || !request.file) {
		return response.status(400).json({ message: '모든 필드를 입력해주세요.' });
	}
	const database = readDb();
	const normalizedStudentNumber = String(studentNumber).trim();
	const normalizedGrade = Number(grade);
	const normalizedClassNumber = Number(classNumber);
	const isSameStudentNumber = record =>
		Number(record.grade) === normalizedGrade &&
		Number(record.classNumber) === normalizedClassNumber &&
		String(record.studentNumber).trim() === normalizedStudentNumber;
	if (database.users.some(isSameStudentNumber) || database.applications.some(isSameStudentNumber)) {
		fs.unlinkSync(request.file.path);
		return response.status(409).json({ message: '이미 가입했거나 가입 신청 중인 동일 학번이 있습니다.' });
	}
	const passwordHash = await bcrypt.hash(password, 10);
	const application = {
		id: Date.now(),
		name, studentNumber: normalizedStudentNumber, email, username, passwordHash,
		grade: normalizedGrade, classNumber: normalizedClassNumber,
		studentCardPath: request.file.path,
		status: 'pending',
		createdAt: new Date().toISOString()
	};
	database.applications.push(application);
	writeDb(database);
	response.status(201).json({ message: '가입 신청이 완료되었습니다. 관리자 승인을 기다려주세요.' });
});

app.post('/api/auth/login', async (request, response) => {
	const { username, password } = request.body;
	if (!username || !password) return response.status(400).json({ message: '아이디와 비밀번호를 입력해주세요.' });
	const database = readDb();
	let user = database.users.find(u => u.username === username);
	let role = 'student';
	if (!user) {
		if (username === process.env.ADMIN_USERNAME) {
			const passwordMatch = await bcrypt.compare(password, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10));
			if (!passwordMatch) return response.status(401).json({ message: '아이디 또는 비밀번호가 잘못되었습니다.' });
			role = 'admin';
			user = { id: 'admin', username: process.env.ADMIN_USERNAME, name: '관리자', role: 'admin' };
		} else {
			return response.status(401).json({ message: '아이디 또는 비밀번호가 잘못되었습니다.' });
		}
	} else {
		if (!await bcrypt.compare(password, user.passwordHash)) return response.status(401).json({ message: '아이디 또는 비밀번호가 잘못되었습니다.' });
	}
	const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'student', grade: user.grade, isClubLeader: user.isClubLeader === true, isStudentMember: user.isStudentMember === true }, JWT_SECRET, { expiresIn: '7d' });
	response.json({ message: '로그인 성공', token, user: { id: user.id, username: user.username, name: user.name, studentNumber: user.studentNumber, email: user.email, profilePhoto: user.profilePhotoPath ? `/uploads/${path.basename(user.profilePhotoPath)}` : null, role: user.role || 'student', grade: user.grade, classNumber: user.classNumber, isClubLeader: user.isClubLeader === true, isStudentMember: user.isStudentMember === true } });
});

app.patch('/api/auth/account', requireAuth, upload.single('profilePhoto'), async (request, response) => {
	if (request.auth.role === 'admin') return response.status(403).json({ message: '관리자 계정은 수정할 수 없습니다.' });
	const { name, studentNumber, email, grade, classNumber, currentPassword, password, passwordConfirm, removeProfilePhoto } = request.body;
	if (!name?.trim() || !studentNumber?.trim() || !email?.trim() || !grade || !classNumber) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '이름, 학번, 이메일, 학년, 반을 모두 입력해주세요.' });
	}
	if (!/^\d+$/.test(String(studentNumber).trim()) || !/^\d+$/.test(String(grade)) || !/^\d+$/.test(String(classNumber))) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '학번, 학년, 반을 올바르게 입력해주세요.' });
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '올바른 이메일을 입력해주세요.' });
	}
	if (password && password.length < 8) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '비밀번호는 8자 이상 입력해주세요.' });
	}
	if (password && (!currentPassword || password !== passwordConfirm)) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '현재 비밀번호와 새 비밀번호 재입력을 확인해주세요.' });
	}
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.auth.id));
	if (!user) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(404).json({ message: '계정을 찾을 수 없습니다.' });
	}
	if (user.name.trim() !== name.trim() || String(user.studentNumber).trim() !== String(studentNumber).trim()) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(400).json({ message: '이름과 학번은 변경할 수 없습니다.' });
	}
	if (password && !await bcrypt.compare(currentPassword, user.passwordHash)) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(401).json({ message: '현재 비밀번호가 올바르지 않습니다.' });
	}
	const duplicate = database.users.some(record => String(record.id) !== String(user.id) && record.name === name.trim() && String(record.studentNumber) === String(studentNumber).trim());
	if (duplicate) {
		if (request.file) fs.unlinkSync(request.file.path);
		return response.status(409).json({ message: '이미 사용 중인 이름과 학번입니다.' });
	}
	const oldProfilePhotoPath = user.profilePhotoPath;
	user.name = name.trim();
	user.studentNumber = studentNumber.trim();
	user.email = email.trim();
	user.grade = Number(grade);
	user.classNumber = Number(classNumber);
	if (password) user.passwordHash = await bcrypt.hash(password, 10);
	if (request.file) user.profilePhotoPath = request.file.path;
	if (removeProfilePhoto === 'true' && !request.file) delete user.profilePhotoPath;
	writeDb(database);
	if ((request.file || removeProfilePhoto === 'true') && oldProfilePhotoPath && oldProfilePhotoPath !== user.profilePhotoPath && fs.existsSync(oldProfilePhotoPath)) fs.unlinkSync(oldProfilePhotoPath);
	response.json({
		message: '회원 정보가 수정되었습니다.',
		user: { id: user.id, username: user.username, name: user.name, studentNumber: user.studentNumber, email: user.email, profilePhoto: user.profilePhotoPath ? `/uploads/${path.basename(user.profilePhotoPath)}` : null, role: user.role || 'student', grade: user.grade, classNumber: user.classNumber }
	});
});

app.get('/api/auth/academic-records', requireAuth, (request, response) => {
	if (request.auth.role === 'admin') return response.json(null);
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.auth.id));
	if (!user) return response.status(404).json({ message: '계정을 찾을 수 없습니다.' });
	response.json(user.academicRecords || null);
});

app.patch('/api/auth/academic-records', requireAuth, (request, response) => {
	if (request.auth.role === 'admin') return response.status(403).json({ message: '관리자 계정에는 성적을 저장할 수 없습니다.' });
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.auth.id));
	if (!user) return response.status(404).json({ message: '계정을 찾을 수 없습니다.' });
	const records = request.body || {};
	if (!records.semesters || typeof records.semesters !== 'object' || Array.isArray(records.semesters)) {
		return response.status(400).json({ message: '성적 데이터 형식이 올바르지 않습니다.' });
	}
	user.academicRecords = {
		gradeSystem: records.gradeSystem === '9' ? '9' : '5',
		schoolTotal: Number.isFinite(Number(records.schoolTotal)) ? Math.max(0, Math.min(Math.floor(Number(records.schoolTotal)), 1000000)) : 0,
		excludedSemesters: Array.isArray(records.excludedSemesters) ? records.excludedSemesters.filter(item => typeof item === 'string') : [],
		semesters: records.semesters
	};
	writeDb(database);
	response.json(user.academicRecords);
});

app.post('/api/inquiries', (request, response) => {
	const { studentName, email, grade, classNum, category, title, content } = request.body || {};
	if (!studentName?.trim() || !email?.trim() || !category?.trim() || !title?.trim() || !content?.trim()) {
		return response.status(400).json({ message: '이름, 이메일, 분류, 제목, 내용을 모두 입력해주세요.' });
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return response.status(400).json({ message: '올바른 이메일을 입력해주세요.' });
	const database = readDb();
	const inquiry = {
		id: Date.now(), studentName: studentName.trim(), email: email.trim(), grade: grade || '', classNum: classNum || '',
		category: category.trim(), title: title.trim(), content: content.trim(), createdAt: new Date().toISOString(), status: '대기'
	};
	database.inquiries.unshift(inquiry);
	writeDb(database);
	response.status(201).json(inquiry);
});

app.get('/api/admin/inquiries', requireAuth, requireAdmin, (request, response) => {
	response.json(readDb().inquiries.sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)));
});

app.post('/api/admin/inquiries/reply', requireAuth, async (request, response) => {
	if (request.auth.role !== 'admin') return response.status(403).json({ message: '관리자 권한이 필요합니다.' });
	const { id, email, title, reply } = request.body;
	if (!email || !reply?.trim()) return response.status(400).json({ message: '이메일과 답변 내용을 입력해주세요.' });
	const emailSent = await sendEmail(email.trim(), `문의 답변: ${title || '학생 문의'}`, reply.trim());
	if (emailSent === false) return response.status(502).json({ message: '이메일을 보내지 못했습니다.' });
	const database = readDb();
	const inquiry = database.inquiries.find(item => String(item.id) === String(id));
	if (inquiry) {
		inquiry.status = '처리 완료';
		inquiry.reply = reply.trim();
		inquiry.repliedAt = new Date().toISOString();
		writeDb(database);
	}
	response.json({ message: '문의 답변을 보냈습니다.' });
});

app.delete('/api/admin/inquiries/:id', requireAuth, requireAdmin, (request, response) => {
	const database = readDb();
	const inquiry = database.inquiries.find(item => String(item.id) === String(request.params.id));
	if (!inquiry) return response.status(404).json({ message: '문의를 찾을 수 없습니다.' });
	if (inquiry.status !== '처리 완료') return response.status(400).json({ message: '처리 완료된 문의만 삭제할 수 있습니다.' });
	database.inquiries = database.inquiries.filter(item => String(item.id) !== String(request.params.id));
	writeDb(database);
	response.status(204).end();
});

app.post('/api/admin/users/email', requireAuth, async (request, response) => {
	if (request.auth.role !== 'admin') return response.status(403).json({ message: '관리자 권한이 필요합니다.' });
	const { email, subject, content } = request.body;
	if (!email || !subject?.trim() || !content?.trim()) return response.status(400).json({ message: '받는 사람, 제목, 내용을 모두 입력해주세요.' });
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return response.status(400).json({ message: '올바른 이메일 주소가 아닙니다.' });
	const emailSent = await sendEmail(email.trim(), subject.trim(), content.trim());
	if (emailSent === false) return response.status(502).json({ message: '이메일을 보내지 못했습니다.' });
	response.json({ message: '이메일을 보냈습니다.' });
});

app.delete('/api/auth/account', requireAuth, async (request, response) => {
	if (request.auth.role === 'admin') return response.status(403).json({ message: '관리자 계정은 탈퇴할 수 없습니다.' });
	const { name, studentNumber, currentPassword } = request.body;
	if (!name) return response.status(400).json({ message: '이름을 입력해주세요.' });
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.auth.id));
	if (!user) return response.status(404).json({ message: '계정을 찾을 수 없습니다.' });
	if (user.role === 'teacher') {
		if (!currentPassword) return response.status(400).json({ message: '현재 비밀번호를 입력해주세요.' });
		if (!await bcrypt.compare(currentPassword, user.passwordHash)) return response.status(403).json({ message: '현재 비밀번호가 올바르지 않습니다.' });
	} else {
		if (!studentNumber) return response.status(400).json({ message: '학번을 입력해주세요.' });
	}
	const enteredStudentNumber = String(studentNumber).trim();
	const storedStudentNumber = String(user.studentNumber).trim();
	const composedStudentNumber = user.grade && user.classNumber
		? `${user.grade}${user.classNumber}${storedStudentNumber.padStart(2, '0')}`
		: storedStudentNumber;
	if (user.name.trim() !== String(name).trim() || (user.role !== 'teacher' && ![storedStudentNumber, composedStudentNumber].includes(enteredStudentNumber))) {
		return response.status(403).json({ message: '이름 또는 학번이 일치하지 않습니다.' });
	}
	database.users = database.users.filter(user => String(user.id) !== String(request.auth.id));
	database.posts = database.posts
		.filter(post => String(post.authorId) !== String(request.auth.id))
		.map(post => ({ ...post, comments: (post.comments || []).filter(comment => String(comment.authorId) !== String(request.auth.id)) }));
	writeDb(database);
	if (user.profilePhotoPath && fs.existsSync(user.profilePhotoPath)) fs.unlinkSync(user.profilePhotoPath);
	response.json({ message: '회원 탈퇴가 완료되었습니다.' });
});

app.get('/api/admin/applications', requireAuth, requireAdmin, (request, response) => {
	const database = readDb();
	response.json(database.applications.map(app => ({ ...app, studentCardPath: app.studentCardPath ? `/uploads/${path.basename(app.studentCardPath)}` : null })));
});

app.get('/api/admin/users', requireAuth, requireAdmin, (request, response) => {
	const database = readDb();
	response.json(database.users.map(user => ({
		id: user.id,
		name: user.name,
		studentNumber: user.studentNumber,
		email: user.email,
		username: user.username,
		role: user.role || 'student',
		grade: user.grade,
		classNumber: user.classNumber,
		isClubLeader: user.isClubLeader === true,
		isStudentMember: user.isStudentMember === true,
		createdAt: user.createdAt,
		profilePhoto: user.profilePhotoPath ? `/uploads/${path.basename(user.profilePhotoPath)}` : null
	})));
});

app.post('/api/admin/teachers', requireAuth, requireAdmin, async (request, response) => {
	const name = String(request.body?.name || '').trim();
	const username = String(request.body?.username || '').trim();
	const email = String(request.body?.email || '').trim();
	const password = String(request.body?.password || '');
	if (!name || name.length > 50) return response.status(400).json({ message: '선생님 이름을 1~50자로 입력해주세요.' });
	if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return response.status(400).json({ message: '아이디는 영문, 숫자, 마침표, 밑줄, 하이픈으로 3~30자까지 입력해주세요.' });
	if (password.length < 8 || password.length > 100) return response.status(400).json({ message: '비밀번호는 8~100자로 입력해주세요.' });
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ message: '이메일 형식이 올바르지 않습니다.' });
	const database = readDb();
	if (username === process.env.ADMIN_USERNAME || database.users.some(user => user.username === username)) {
		return response.status(409).json({ message: '이미 사용 중인 아이디입니다.' });
	}
	const teacher = {
		id: Date.now(),
		name,
		username,
		email,
		passwordHash: await bcrypt.hash(password, 10),
		role: 'teacher',
		createdAt: new Date().toISOString()
	};
	database.users.push(teacher);
	writeDb(database);
	response.status(201).json({ id: teacher.id, name: teacher.name, username: teacher.username, email: teacher.email, role: teacher.role });
});

app.patch('/api/admin/users/:id/qualifications', requireAuth, requireAdmin, (request, response) => {
	const { isClubLeader, isStudentMember } = request.body || {};
	if (typeof isClubLeader !== 'boolean' || typeof isStudentMember !== 'boolean') {
		return response.status(400).json({ message: '자격 정보를 올바르게 입력해주세요.' });
	}
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.params.id));
	if (!user) return response.status(404).json({ message: '학생 계정을 찾을 수 없습니다.' });
	user.isClubLeader = isClubLeader;
	user.isStudentMember = isStudentMember;
	writeDb(database);
	response.json({
		message: '학생 자격을 저장했습니다.',
		user: { id: user.id, isClubLeader: user.isClubLeader, isStudentMember: user.isStudentMember }
	});
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (request, response) => {
	const { adminPassword } = request.body || {};
	if (!adminPassword) return response.status(400).json({ message: '관리자 비밀번호를 입력해주세요.' });
	if (!process.env.ADMIN_PASSWORD) return response.status(500).json({ message: '관리자 비밀번호가 서버에 설정되지 않았습니다.' });
	const passwordMatch = await bcrypt.compare(adminPassword, await bcrypt.hash(process.env.ADMIN_PASSWORD, 10));
	if (!passwordMatch) return response.status(403).json({ message: '관리자 비밀번호가 올바르지 않습니다.' });
	const database = readDb();
	const user = database.users.find(record => String(record.id) === String(request.params.id));
	if (!user) return response.status(404).json({ message: '학생 계정을 찾을 수 없습니다.' });
	database.users = database.users.filter(record => String(record.id) !== String(user.id));
	database.posts = database.posts
		.filter(post => String(post.authorId) !== String(user.id))
		.map(post => ({ ...post, comments: (post.comments || []).filter(comment => String(comment.authorId) !== String(user.id)) }));
	writeDb(database);
	if (user.profilePhotoPath && fs.existsSync(user.profilePhotoPath)) fs.unlinkSync(user.profilePhotoPath);
	response.json({ message: '학생 계정을 삭제했습니다.' });
});

app.patch('/api/admin/applications/:id/approve', requireAuth, requireAdmin, async (request, response) => {
	const database = readDb();
	const application = database.applications.find(record => String(record.id) === request.params.id);
	if (!application) return response.status(404).json({ message: '가입 신청을 찾을 수 없습니다.' });
	const user = {
		id: Date.now(),
		name: application.name,
		studentNumber: application.studentNumber,
		email: application.email,
		username: application.username,
		passwordHash: application.passwordHash,
		grade: application.grade,
		classNumber: application.classNumber,
		role: 'student',
		createdAt: new Date().toISOString()
	};
	const emailSent = await sendEmail(application.email, '가입 신청 승인 안내', `${application.name}님의 가입 신청이 승인되었습니다.`);
	database.users.push(user);
	database.applications = database.applications.filter(record => String(record.id) !== request.params.id);
	writeDb(database);
	fs.rmSync(application.studentCardPath, { force: true });
	response.json({ message: emailSent ? '가입 신청을 승인했습니다.' : '가입 신청을 승인했지만 이메일 발송에는 실패했습니다.' });
});

app.patch('/api/admin/applications/:id/reject', requireAuth, requireAdmin, async (request, response) => {
	const database = readDb();
	const application = database.applications.find(record => String(record.id) === request.params.id);
	if (!application) return response.status(404).json({ message: '가입 신청을 찾을 수 없습니다.' });
	const emailSent = await sendEmail(application.email, '가입 신청 반려 안내', '가입 신청이 반려되었습니다. 자세한 내용은 관리자에게 문의해주세요.');
	database.applications = database.applications.filter(record => String(record.id) !== request.params.id);
	writeDb(database);
	fs.rmSync(application.studentCardPath, { force: true });
	response.json({ message: emailSent ? '가입 신청을 반려했습니다.' : '가입 신청을 반려했지만 이메일 발송에는 실패했습니다.' });
});

app.get('/api/posts', requireAuth, (request, response) => {
	const database = readDb();
	const posts = database.posts.map(post => {
		if (!post.poll) return post;
		const userVote = post.poll.votes?.[String(request.auth.id)] || null;
		return { ...post, poll: { question: post.poll.question, options: post.poll.options, closed: post.poll.closed === true, userVote } };
	});
	if (request.auth.role === 'admin') {
		return response.json(posts.map(post => ({
			...post,
			realAuthorName: database.users.find(user => String(user.id) === String(post.authorId))?.name || null
		})));
	}
	response.json(posts.filter(post => {
		const category = post.category === 'freshman' ? 'grade1' : post.category;
		const match = (category || '').match(/^grade([123])$/);
		return !match || Number(match[1]) === Number(request.auth.grade);
	}));
});

app.get('/api/notices', (request, response) => {
	const notices = readDb().notices;
	response.json(notices.sort((first, second) => new Date(second.createdAt || second.date || second.id).getTime() - new Date(first.createdAt || first.date || first.id).getTime()));
});

app.post('/api/notices', requireAuth, requireAdmin, (request, response) => {
	const { title, content, category } = request.body || {};
	if (!title?.trim() || !content?.trim()) return response.status(400).json({ message: '제목과 내용을 모두 입력해 주세요.' });
	const trimmedContent = content.trim();
	const notice = {
		id: Date.now(),
		title: title.trim(),
		category: category || '학사',
		date: new Date().toISOString().slice(0, 10),
		summary: trimmedContent.length > 120 ? `${trimmedContent.slice(0, 120)}...` : trimmedContent,
		content: trimmedContent,
		createdAt: new Date().toISOString()
	};
	const database = readDb();
	database.notices.push(notice);
	writeDb(database);
	response.status(201).json(notice);
});

app.patch('/api/notices/:id', requireAuth, requireAdmin, (request, response) => {
	const { title, content, category } = request.body || {};
	if (!title?.trim() || !content?.trim()) return response.status(400).json({ message: '제목과 내용을 모두 입력해 주세요.' });
	const database = readDb();
	const notice = database.notices.find(record => String(record.id) === String(request.params.id));
	if (!notice) return response.status(404).json({ message: '공지사항을 찾을 수 없습니다.' });
	const trimmedContent = content.trim();
	notice.title = title.trim();
	notice.category = category || '학사';
	notice.summary = trimmedContent.length > 120 ? `${trimmedContent.slice(0, 120)}...` : trimmedContent;
	notice.content = trimmedContent;
	writeDb(database);
	response.json(notice);
});

app.delete('/api/notices/:id', requireAuth, requireAdmin, (request, response) => {
	const database = readDb();
	const noticeExists = database.notices.some(record => String(record.id) === String(request.params.id));
	if (!noticeExists) return response.status(404).json({ message: '공지사항을 찾을 수 없습니다.' });
	database.notices = database.notices.filter(record => String(record.id) !== String(request.params.id));
	writeDb(database);
	response.status(204).end();
});

app.get('/api/categories', requireAuth, (request, response) => {
	const categories = readDb().customCategories;
	response.json(request.auth.role === 'admin' ? categories : categories.filter(category => category.isVisible !== false));
});

app.post('/api/admin/categories', requireAuth, requireAdmin, (request, response) => {
	const name = String(request.body?.name || '').trim();
	if (!name || name.length > 30) return response.status(400).json({ message: '카테고리 이름은 1~30자로 입력해주세요.' });
	const database = readDb();
	const builtInNames = ['자유게시판', '1학년 게시판', '2학년 게시판', '3학년 게시판', '공부 & 수행평가', '동아리 / 학생회'];
	if (builtInNames.includes(name) || database.customCategories.some(category => category.name === name)) {
		return response.status(409).json({ message: '이미 사용 중인 카테고리 이름입니다.' });
	}
	const icon = CATEGORY_ICONS.has(request.body?.icon) ? request.body.icon : 'folder';
	const color = CATEGORY_COLORS.has(request.body?.color) ? request.body.color : 'slate';
	const category = { id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`, name, icon, color, isVisible: true, createdAt: new Date().toISOString() };
	database.customCategories.push(category);
	writeDb(database);
	response.status(201).json(category);
});

app.patch('/api/admin/categories/:id', requireAuth, requireAdmin, (request, response) => {
	const { icon, color, isVisible } = request.body || {};
	if (icon !== undefined && !CATEGORY_ICONS.has(icon)) return response.status(400).json({ message: '지원하지 않는 카테고리 아이콘입니다.' });
	if (color !== undefined && !CATEGORY_COLORS.has(color)) return response.status(400).json({ message: '지원하지 않는 카테고리 색상입니다.' });
	if (isVisible !== undefined && typeof isVisible !== 'boolean') return response.status(400).json({ message: '카테고리 노출 여부가 올바르지 않습니다.' });
	if (icon === undefined && color === undefined && isVisible === undefined) return response.status(400).json({ message: '변경할 값을 입력해주세요.' });
	const database = readDb();
	const category = database.customCategories.find(item => String(item.id) === String(request.params.id));
	if (!category) return response.status(404).json({ message: '카테고리를 찾을 수 없습니다.' });
	if (icon !== undefined) category.icon = icon;
	if (color !== undefined) category.color = color;
	if (isVisible !== undefined) category.isVisible = isVisible;
	writeDb(database);
	response.json(category);
});

app.delete('/api/admin/categories/:id', requireAuth, requireAdmin, (request, response) => {
	const database = readDb();
	const category = database.customCategories.find(item => String(item.id) === String(request.params.id));
	if (!category) return response.status(404).json({ message: '카테고리를 찾을 수 없습니다.' });
	const deletedPostCount = database.posts.filter(post => String(post.category) === String(category.id)).length;
	database.posts = database.posts.filter(post => String(post.category) !== String(category.id));
	database.customCategories = database.customCategories.filter(item => String(item.id) !== String(request.params.id));
	writeDb(database);
	response.json({ message: '카테고리와 게시글을 삭제했습니다.', deletedPostCount });
});

app.get('/api/custom-schedules', requireAuth, (request, response) => {
	const database = readDb();
	const customSchedules = (database.customSchedules || []).filter(item => String(item.authorId) === String(request.auth.id));
	response.json(customSchedules);
});

app.post('/api/custom-schedules', requireAuth, (request, response) => {
	const database = readDb();
	const { title, date } = request.body || {};
	if (!date || !title?.trim()) return response.status(400).json({ message: '날짜와 일정 내용을 모두 입력해주세요.' });
	const item = {
		id: request.body.id || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		authorId: request.auth.id,
		date,
		title: title.trim()
	};
	database.customSchedules.push(item);
	writeDb(database);
	response.status(201).json(item);
});

app.put('/api/custom-schedules/:id', requireAuth, (request, response) => {
	const database = readDb();
	const item = (database.customSchedules || []).find(schedule => String(schedule.id) === String(request.params.id));
	if (!item || String(item.authorId) !== String(request.auth.id)) return response.status(403).json({ message: '수정 권한이 없습니다.' });
	const { title, date } = request.body || {};
	if (!date || !title?.trim()) return response.status(400).json({ message: '날짜와 일정 내용을 모두 입력해주세요.' });
	item.date = date;
	item.title = title.trim();
	writeDb(database);
	response.json(item);
});

app.delete('/api/custom-schedules/:id', requireAuth, (request, response) => {
	const database = readDb();
	const item = (database.customSchedules || []).find(schedule => String(schedule.id) === String(request.params.id));
	if (!item || String(item.authorId) !== String(request.auth.id)) return response.status(403).json({ message: '삭제 권한이 없습니다.' });
	database.customSchedules = (database.customSchedules || []).filter(schedule => String(schedule.id) !== String(request.params.id));
	writeDb(database);
	response.status(204).end();
});
app.post('/api/posts', requireAuth, (request, response) => {
	const database = readDb();
	const requestedCategory = request.body.category === 'freshman' ? 'grade1' : request.body.category;
	if (requestedCategory === 'club' && request.auth.role !== 'admin' && !request.auth.isClubLeader && !request.auth.isStudentMember) {
		return response.status(403).json({ message: '동아리장 또는 학생회원만 동아리·학생회 게시판에 글을 작성할 수 있습니다.' });
	}
	const gradeMatch = requestedCategory?.match(/^grade([123])$/);
	if (gradeMatch && request.auth.role !== 'admin' && Number(gradeMatch[1]) !== Number(request.auth.grade)) {
		return response.status(403).json({ message: '자신의 학년 게시판에만 글을 작성할 수 있습니다.' });
	}
	let poll;
	if (request.body.poll) {
		const question = String(request.body.poll.question || '').trim();
		const optionTexts = Array.isArray(request.body.poll.options)
			? request.body.poll.options.map(option => String(option).trim()).filter(Boolean)
			: [];
		if (!question || question.length > 120 || optionTexts.length < 2) {
			return response.status(400).json({ message: '투표 질문과 선택지를 확인해주세요.' });
		}
		poll = {
			question,
			options: optionTexts.map((text, index) => ({ id: `option-${index + 1}`, text, votes: 0 })),
			closed: false,
			votes: {}
		};
	}
	const post = { id: Date.now(), authorId: request.auth.id, ...request.body, poll, category: requestedCategory, createdAt: new Date().toISOString(), comments: [], likes: 0 };
	database.posts.push(post);
	writeDb(database);
	const { votes, ...publicPoll } = poll || {};
	response.status(201).json({ ...post, poll: poll ? { ...publicPoll, userVote: null } : null });
});
app.post('/api/posts/:id/poll-vote', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === String(request.params.id));
	if (!post?.poll) return response.status(404).json({ message: '투표를 찾을 수 없습니다.' });
	if (post.poll.closed === true) return response.status(400).json({ message: '마감된 투표입니다.' });
	const optionId = String(request.body?.optionId || '');
	if (!post.poll.options.some(option => option.id === optionId)) return response.status(400).json({ message: '올바른 선택지를 선택해주세요.' });
	if (!post.poll.votes || typeof post.poll.votes !== 'object') post.poll.votes = {};
	const voterId = String(request.auth.id);
	const previousOptionId = post.poll.votes[voterId];
	if (previousOptionId === optionId) return response.status(400).json({ message: '이미 선택한 투표입니다.' });
	if (previousOptionId) {
		const previousOption = post.poll.options.find(option => option.id === previousOptionId);
		if (previousOption) previousOption.votes = Math.max(0, Number(previousOption.votes || 0) - 1);
	}
	const option = post.poll.options.find(item => item.id === optionId);
	option.votes = Number(option.votes || 0) + 1;
	post.poll.votes[voterId] = optionId;
	writeDb(database);
	response.json({ ...post.poll, userVote: optionId });
});
app.delete('/api/posts/:id/poll-vote', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === String(request.params.id));
	if (!post?.poll) return response.status(404).json({ message: '투표를 찾을 수 없습니다.' });
	if (post.poll.closed === true) return response.status(400).json({ message: '마감된 투표는 취소할 수 없습니다.' });
	const voterId = String(request.auth.id);
	const optionId = post.poll.votes?.[voterId];
	if (!optionId) return response.status(400).json({ message: '취소할 투표가 없습니다.' });
	const option = post.poll.options.find(item => item.id === optionId);
	if (option) option.votes = Math.max(0, Number(option.votes || 0) - 1);
	delete post.poll.votes[voterId];
	writeDb(database);
	response.json({ ...post.poll, userVote: null });
});
app.patch('/api/posts/:id/poll-close', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === String(request.params.id));
	if (!post?.poll) return response.status(404).json({ message: '투표를 찾을 수 없습니다.' });
	if (request.auth.role !== 'admin' && String(post.authorId) !== String(request.auth.id)) return response.status(403).json({ message: '투표를 마감할 권한이 없습니다.' });
	post.poll.closed = true;
	writeDb(database);
	response.json({ ...post.poll, userVote: post.poll.votes?.[String(request.auth.id)] || null });
});
app.delete('/api/posts/:id', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === request.params.id);
	if (!post || (request.auth.role !== 'admin' && post.authorId !== request.auth.id)) return response.status(403).json({ message: '삭제 권한이 없습니다.' });
	database.posts = database.posts.filter(record => String(record.id) !== request.params.id);
	writeDb(database);
	response.status(204).end();
});
app.post('/api/posts/:id/comments', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === request.params.id);
	const attachments = Array.isArray(request.body.attachments) ? request.body.attachments : [];
	if (!post || (!request.body.text?.trim() && attachments.length === 0)) return response.status(400).json({ message: '댓글 내용을 입력해주세요.' });
	if (attachments.length > 10 || attachments.some(file => !file || typeof file.dataUrl !== 'string' || file.dataUrl.length > 7 * 1024 * 1024)) {
		return response.status(400).json({ message: '첨부 파일을 확인해주세요.' });
	}
	const comment = { id: Date.now(), authorId: request.auth.id, author: request.body.isAnonymous ? '익명' : request.auth.username, text: request.body.text?.trim() || '', attachments, createdAt: new Date().toISOString() };
	post.comments.push(comment);
	writeDb(database);
	response.status(201).json(comment);
});
app.delete('/api/posts/:postId/comments/:commentId', requireAuth, (request, response) => {
	const database = readDb();
	const post = database.posts.find(record => String(record.id) === request.params.postId);
	const comment = post?.comments.find(record => String(record.id) === request.params.commentId);
	if (!comment || (request.auth.role !== 'admin' && comment.authorId !== request.auth.id)) return response.status(403).json({ message: '삭제 권한이 없습니다.' });
	post.comments = post.comments.filter(record => String(record.id) !== request.params.commentId);
	writeDb(database);
	response.status(204).end();
});

const server = app.listen(PORT, () => console.log(`Samcheok HUB backend listening on http://localhost:${PORT}`));
server.on('error', error => {
	if (error.code === 'EADDRINUSE') {
		console.error(`Port ${PORT} is already in use. The backend may already be running.`);
		process.exit(1);
	}
	console.error('Backend failed to start:', error.message);
});
