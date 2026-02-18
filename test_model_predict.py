import os
import cv2
import numpy as np
import json
from tensorflow import keras
import glob

print("=" * 50)
print("🧪 TESTING CAPTCHA MODEL PREDICTIONS")
print("=" * 50)

# Check if model files exist
if not os.path.exists('captcha_solver_final.h5'):
    print("❌ ERROR: Model file 'captcha_solver_final.h5' not found!")
    print("   Make sure you're in the same directory as the model file.")
    exit(1)

if not os.path.exists('captcha_labels.json'):
    print("❌ ERROR: Labels file 'captcha_labels.json' not found!")
    exit(1)

# Load model
print("\n📂 Loading model...")
model = keras.models.load_model('captcha_solver_final.h5')
print("✅ Model loaded successfully!")

# Load labels
print("📂 Loading labels...")
with open('captcha_labels.json', 'r') as f:
    labels = json.load(f)
print(f"✅ Labels loaded: {len(labels)} characters")

# Create reverse mapping
idx_to_char = {v: k for k, v in labels.items()}
print(f"✅ Character mapping ready")

def preprocess_image(image_path):
    """Preprocess image for the model"""
    # Read image
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    
    # Resize to model input size (200x50)
    img = cv2.resize(img, (200, 50))
    
    # Normalize to 0-1
    img = img.astype('float32') / 255.0
    
    # Add channel dimension
    img = np.expand_dims(img, axis=-1)
    
    # Add batch dimension
    img = np.expand_dims(img, axis=0)
    
    return img

def predict_captcha(image_path):
    """Predict CAPTCHA text from image"""
    # Preprocess
    img = preprocess_image(image_path)
    if img is None:
        return None
    
    # Predict
    predictions = model.predict(img, verbose=0)[0]
    
    # Decode predictions
    captcha_text = ''
    for position_pred in predictions:
        char_idx = np.argmax(position_pred)
        if char_idx in idx_to_char:
            captcha_text += idx_to_char[char_idx]
    
    return captcha_text

# Find some sample images to test
print("\n🔍 Looking for CAPTCHA images to test...")

# Look in different possible locations
sample_folders = [
    'samples',
    'training_data',
    'captchas',
    '.'
]

test_images = []

for folder in sample_folders:
    if os.path.exists(folder):
        images = glob.glob(os.path.join(folder, "*.png")) + glob.glob(os.path.join(folder, "*.jpg"))
        if images:
            print(f"Found {len(images)} images in '{folder}/'")
            test_images.extend(images[:10])  # Take first 10 from each folder

# If no images found, create a test from current directory
if not test_images:
    print("⚠️  No sample images found in common folders.")
    print("Please provide a path to a CAPTCHA image to test:")
    print("\nUsage examples:")
    print("  python test_model_predict.py path/to/captcha.png")
    print("  python test_model_predict.py (will ask for path)")
    
    # Ask user for image path
    image_path = input("\n📝 Enter path to CAPTCHA image: ").strip()
    if os.path.exists(image_path):
        test_images = [image_path]
    else:
        print(f"❌ File not found: {image_path}")
        exit(1)

# Test predictions
print("\n" + "=" * 50)
print("🔮 MAKING PREDICTIONS")
print("=" * 50)

correct = 0
total = 0

for i, img_path in enumerate(test_images[:10], 1):
    filename = os.path.basename(img_path)
    
    # Get expected text from filename (if filename is the CAPTCHA text)
    expected = os.path.splitext(filename)[0]
    
    print(f"\n📸 Image {i}: {filename}")
    
    # Predict
    predicted = predict_captcha(img_path)
    
    if predicted is None:
        print(f"❌ Failed to read image")
        continue
    
    print(f"   Predicted: '{predicted}'")
    
    # Check if filename looks like a CAPTCHA (all uppercase alphanumeric)
    if expected.isalnum() and len(expected) <= 8:
        print(f"   Expected:  '{expected}'")
        is_correct = predicted == expected
        if is_correct:
            print(f"   ✅ CORRECT!")
            correct += 1
        else:
            print(f"   ❌ WRONG")
        total += 1
    else:
        print(f"   (No expected value - filename is '{expected}')")
    
    # Show confidence scores
    print(f"\n   Character-by-character confidence:")
    img = preprocess_image(img_path)
    if img is not None:
        predictions = model.predict(img, verbose=0)[0]
        for pos, pred in enumerate(predictions):
            confidence = np.max(pred) * 100
            char = predicted[pos] if pos < len(predicted) else '?'
            print(f"      Position {pos+1}: '{char}' ({confidence:.1f}% confidence)")

print("\n" + "=" * 50)
print("📊 SUMMARY")
print("=" * 50)

if total > 0:
    accuracy = (correct / total) * 100
    print(f"Accuracy: {accuracy:.1f}% ({correct}/{total})")
else:
    print("No validation data available (filenames weren't CAPTCHA text)")

print("\n💡 Next steps:")
print("1. To use this model in your scraping, update your Node.js script")
print("2. The model file is ready at: captcha_solver_final.h5")
print("3. Labels file at: captcha_labels.json")
print("\nRun with a specific image: python test_model_predict.py path/to/image.png")