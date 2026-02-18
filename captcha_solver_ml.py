import sys
import json
import base64
import cv2
import numpy as np
import pytesseract
import re
import os
import pickle
from sklearn import svm
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score
import joblib
from collections import defaultdict
import warnings
warnings.filterwarnings('ignore')

pytesseract.pytesseract.tesseract_cmd = r"C:\Users\h.qotbi\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"

CAPTCHA_LEN = 6
MODEL_PATH = "captcha_model.pkl"
SCALER_PATH = "captcha_scaler.pkl"
TRAINING_DATA_PATH = "training_data.npz"

class MLEnhancedCaptchaSolver:
    def __init__(self):
        self.model = None
        self.scaler = StandardScaler()
        self.training_data = []
        self.training_labels = []
        self.character_mapping = {c: i for i, c in enumerate('abcdefghijklmnopqrstuvwxyz0123456789')}
        self.reverse_mapping = {i: c for c, i in self.character_mapping.items()}
        self.num_classes = len(self.character_mapping)
        
        # Load existing model if available
        self.load_model()
    
    def load_model(self):
        """Load pre-trained model if exists"""
        if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
            try:
                self.model = joblib.load(MODEL_PATH)
                self.scaler = joblib.load(SCALER_PATH)
                print("Model loaded successfully", file=sys.stderr)
            except:
                print("Failed to load model, will train new one", file=sys.stderr)
        
        # Load training data if exists
        if os.path.exists(TRAINING_DATA_PATH):
            try:
                data = np.load(TRAINING_DATA_PATH)
                self.training_data = list(data['features'])
                self.training_labels = list(data['labels'])
                print(f"Loaded {len(self.training_data)} training samples", file=sys.stderr)
            except:
                print("Failed to load training data", file=sys.stderr)
    
    def save_model(self):
        """Save trained model"""
        if self.model is not None:
            joblib.dump(self.model, MODEL_PATH)
            joblib.dump(self.scaler, SCALER_PATH)
            print("Model saved successfully", file=sys.stderr)
    
    def save_training_data(self):
        """Save accumulated training data"""
        if self.training_data and self.training_labels:
            np.savez(TRAINING_DATA_PATH, 
                     features=np.array(self.training_data), 
                     labels=np.array(self.training_labels))
            print(f"Saved {len(self.training_data)} training samples", file=sys.stderr)
    
    def extract_features(self, img):
        """Extract numerical features from image for ML model"""
        features = []
        
        # Basic image statistics
        features.append(np.mean(img))
        features.append(np.std(img))
        
        # Histogram features
        hist = cv2.calcHist([img], [0], None, [16], [0, 256]).flatten()
        features.extend(hist / hist.sum() if hist.sum() > 0 else hist)
        
        # Edge features
        edges = cv2.Canny(img, 50, 150)
        features.append(np.sum(edges > 0) / edges.size)  # Edge density
        
        # Texture features using HOG (simplified)
        hog_features = self.extract_hog_features(img)
        features.extend(hog_features)
        
        # Vertical and horizontal projection features
        h_proj = np.sum(img, axis=1) / 255
        v_proj = np.sum(img, axis=0) / 255
        
        # Normalize projections
        if np.max(h_proj) > 0:
            h_proj = h_proj / np.max(h_proj)
        if np.max(v_proj) > 0:
            v_proj = v_proj / np.max(v_proj)
        
        # Sample projections at regular intervals
        sample_points = 10
        for i in range(sample_points):
            idx = int(i * len(h_proj) / sample_points)
            features.append(h_proj[idx] if idx < len(h_proj) else 0)
        
        for i in range(sample_points):
            idx = int(i * len(v_proj) / sample_points)
            features.append(v_proj[idx] if idx < len(v_proj) else 0)
        
        return np.array(features)
    
    def extract_hog_features(self, img, resize_dim=(32, 32)):
        """Simplified HOG feature extraction"""
        # Resize to fixed size
        img_resized = cv2.resize(img, resize_dim)
        
        # Calculate gradients
        gx = cv2.Sobel(img_resized, cv2.CV_32F, 1, 0, ksize=1)
        gy = cv2.Sobel(img_resized, cv2.CV_32F, 0, 1, ksize=1)
        
        # Calculate magnitude and orientation
        mag, ang = cv2.cartToPolar(gx, gy)
        
        # Quantize orientations into bins
        bin_size = 20  # 9 bins from 0-180
        bins = np.int32(bin_size * ang / (np.pi))
        
        # Calculate HOG
        cell_size = 8
        block_size = 2
        cell_x = resize_dim[0] // cell_size
        cell_y = resize_dim[1] // cell_size
        
        hog_features = []
        for i in range(cell_y - block_size + 1):
            for j in range(cell_x - block_size + 1):
                block_mag = mag[i*cell_size:(i+block_size)*cell_size, 
                               j*cell_size:(j+block_size)*cell_size]
                block_bins = bins[i*cell_size:(i+block_size)*cell_size, 
                                 j*cell_size:(j+block_size)*cell_size]
                
                hist = np.zeros(9)
                for k in range(block_size*cell_size):
                    for l in range(block_size*cell_size):
                        if k < block_mag.shape[0] and l < block_mag.shape[1]:
                            bin_idx = block_bins[k, l] % 9
                            hist[bin_idx] += block_mag[k, l]
                
                # Normalize
                if np.linalg.norm(hist) > 0:
                    hist = hist / np.linalg.norm(hist)
                hog_features.extend(hist)
        
        # Ensure fixed length
        fixed_length = 3780  # Common HOG length
        if len(hog_features) < fixed_length:
            hog_features.extend([0] * (fixed_length - len(hog_features)))
        else:
            hog_features = hog_features[:fixed_length]
        
        return hog_features
    
    def preprocess(self, img_bytes):
        """Preprocess image for both Tesseract and ML model"""
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise Exception("Failed to decode captcha image")
        
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Multiple preprocessing variations for ML training
        variations = []
        
        # Original scaling
        gray_large = cv2.resize(gray, None, fx=7, fy=7, interpolation=cv2.INTER_CUBIC)
        blur = cv2.GaussianBlur(gray_large, (3, 3), 0)
        _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        kernel = np.ones((2, 2), np.uint8)
        th = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel)
        
        variations.append(("standard", th))
        
        # Variation 1: Different threshold
        _, th2 = cv2.threshold(blur, 127, 255, cv2.THRESH_BINARY)
        th2 = cv2.morphologyEx(th2, cv2.MORPH_OPEN, kernel)
        variations.append(("threshold127", th2))
        
        # Variation 2: Adaptive threshold
        th3 = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
        th3 = cv2.morphologyEx(th3, cv2.MORPH_OPEN, kernel)
        variations.append(("adaptive", th3))
        
        return variations
    
    def ocr_with_ml_rerank(self, img_variations):
        """Use ML model to rerank Tesseract results"""
        all_candidates = []
        
        for var_name, img in img_variations:
            # Get Tesseract results with multiple PSMs
            configs = [
                "--oem 3 --psm 7 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz0123456789",
                "--oem 3 --psm 8 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz0123456789",
                "--oem 1 --psm 7 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz0123456789"
            ]
            
            for config in configs:
                data = pytesseract.image_to_data(img, config=config, output_type=pytesseract.Output.DICT)
                
                parts = []
                confs = []
                
                for i in range(len(data["text"])):
                    txt = self.clean_text(data["text"][i])
                    conf = int(float(data["conf"][i])) if data["conf"][i] != "-1" else -1
                    
                    if txt:
                        parts.append(txt)
                        confs.append(conf)
                
                merged = self.clean_text("".join(parts))
                
                # Limit to expected length
                if len(merged) > CAPTCHA_LEN:
                    merged = merged[:CAPTCHA_LEN]
                
                # Extract ML features for this candidate
                if merged and len(merged) == CAPTCHA_LEN:
                    features = self.extract_features(img)
                    
                    # Get ML prediction confidence if model exists
                    ml_confidence = 0.5
                    if self.model is not None:
                        try:
                            features_scaled = self.scaler.transform([features])
                            proba = self.model.predict_proba(features_scaled)[0]
                            ml_confidence = np.max(proba)
                        except:
                            pass
                    
                    all_candidates.append({
                        'text': merged,
                        'tesseract_conf': np.mean(confs) if confs else 0,
                        'ml_confidence': ml_confidence,
                        'length_match': len(merged) == CAPTCHA_LEN,
                        'features': features
                    })
        
        # Score and rank candidates
        for cand in all_candidates:
            cand['score'] = (
                cand['tesseract_conf'] / 100 * 0.4 +  # Tesseract confidence (40%)
                cand['ml_confidence'] * 0.4 +         # ML confidence (40%)
                (1 if cand['length_match'] else 0) * 0.2  # Length match (20%)
            )
        
        # Sort by score
        all_candidates.sort(key=lambda x: x['score'], reverse=True)
        
        return all_candidates[0]['text'] if all_candidates else ""
    
    def clean_text(self, s):
        """Clean and normalize text"""
        s = (s or "").lower()
        s = re.sub(r"[^a-z0-9]", "", s)
        return s
    
    def train_model(self):
        """Train ML model on accumulated data"""
        if len(self.training_data) < 10:
            print(f"Not enough training data: {len(self.training_data)} samples (need at least 10)", file=sys.stderr)
            return False
        
        X = np.array(self.training_data)
        y = np.array(self.training_labels)
        
        # Filter out invalid labels
        valid_indices = [i for i, label in enumerate(y) if len(label) == CAPTCHA_LEN]
        X = X[valid_indices]
        y = y[valid_indices]
        
        if len(X) == 0:
            print("No valid training samples with correct length", file=sys.stderr)
            return False
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        
        # Scale features
        self.scaler.fit(X_train)
        X_train_scaled = self.scaler.transform(X_train)
        X_test_scaled = self.scaler.transform(X_test)
        
        # Train model
        try:
            # Use neural network for better accuracy
            self.model = MLPClassifier(
                hidden_layer_sizes=(256, 128, 64),
                activation='relu',
                solver='adam',
                max_iter=500,
                random_state=42
            )
            
            # Convert string labels to indices
            y_train_indices = np.array([hash(label) % 1000 for label in y_train])
            y_test_indices = np.array([hash(label) % 1000 for label in y_test])
            
            self.model.fit(X_train_scaled, y_train_indices)
            
            # Evaluate
            train_pred = self.model.predict(X_train_scaled)
            test_pred = self.model.predict(X_test_scaled)
            
            train_acc = accuracy_score(y_train_indices, train_pred)
            test_acc = accuracy_score(y_test_indices, test_pred)
            
            print(f"Model trained - Train accuracy: {train_acc:.3f}, Test accuracy: {test_acc:.3f}", file=sys.stderr)
            
            self.save_model()
            return True
            
        except Exception as e:
            print(f"Training failed: {e}", file=sys.stderr)
            return False
    
    def add_training_sample(self, image_bytes, correct_text):
        """Add a new training sample (image + correct text)"""
        variations = self.preprocess(image_bytes)
        
        for var_name, img in variations:
            features = self.extract_features(img)
            self.training_data.append(features)
            self.training_labels.append(correct_text)
        
        print(f"Added training sample with text: {correct_text}", file=sys.stderr)
        self.save_training_data()
        
        # Retrain periodically
        if len(self.training_data) % 20 == 0:
            self.train_model()
    
    def solve_captcha(self, base64_image: str, correct_text=None) -> str:
        """Main solving function with optional training"""
        img_bytes = base64.b64decode(base64_image)
        variations = self.preprocess(img_bytes)
        
        # If correct text is provided, add to training data
        if correct_text and len(correct_text) == CAPTCHA_LEN:
            self.add_training_sample(img_bytes, correct_text)
        
        # Solve using ML-enhanced OCR
        solution = self.ocr_with_ml_rerank(variations)
        
        # Fallback to simple OCR if ML-enhanced fails
        if not solution or len(solution) != CAPTCHA_LEN:
            # Try simple OCR
            for _, img in variations:
                config = "--oem 3 --psm 7 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz0123456789"
                text = pytesseract.image_to_string(img, config=config)
                text = self.clean_text(text)
                
                if len(text) == CAPTCHA_LEN:
                    solution = text
                    break
                
                # Try inverted
                inv = cv2.bitwise_not(img)
                text = pytesseract.image_to_string(inv, config=config)
                text = self.clean_text(text)
                
                if len(text) == CAPTCHA_LEN:
                    solution = text
                    break
            
            if not solution or len(solution) != CAPTCHA_LEN:
                # Last resort: take first 6 chars
                solution = self.clean_text(text)[:CAPTCHA_LEN]
        
        return solution

# Global solver instance
solver = MLEnhancedCaptchaSolver()

def solve_captcha(base64_image: str, correct_text=None) -> str:
    """Wrapper function for compatibility"""
    return solver.solve_captcha(base64_image, correct_text)

def train_on_feedback(base64_image: str, correct_text: str):
    """Explicitly train on correct captcha"""
    return solver.add_training_sample(base64.b64decode(base64_image), correct_text)

if __name__ == "__main__":
    raw_input = sys.stdin.read().strip()
    
    try:
        try:
            parsed = json.loads(raw_input)
            base64_image = parsed.get("image") or ""
            correct_text = parsed.get("correct")  # Optional correct text for training
            feedback = parsed.get("feedback")     # Alternative way to provide correction
        except:
            base64_image = raw_input
            correct_text = None
            feedback = None
        
        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",", 1)[1]
        
        if not base64_image:
            raise Exception("No base64 image provided")
        
        # Use correct text from either field
        training_text = correct_text or feedback
        
        solution = solve_captcha(base64_image, training_text)
        
        # Return solution and training status
        result = {
            "success": True,
            "solution": solution,
            "trained": training_text is not None,
            "samples": len(solver.training_data)
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))